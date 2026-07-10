package collector

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/rohitjain/ch-analyzer/internal/chclient"
	"github.com/rohitjain/ch-analyzer/internal/config"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
	metricsv "k8s.io/metrics/pkg/client/clientset/versioned"
)

// K8sCollector queries the Kubernetes API and Metrics API for ClickHouse pod
// resource usage, OOMKills, and restarts. It is disabled (no-op) when K8s
// config says Enabled=false or when no K8s cluster is reachable.
type K8sCollector struct {
	Config config.K8sConfig
	Logger *slog.Logger

	// Lazy-initialised clients. Nil until first Collect or if K8s is unreachable.
	kubeClient    kubernetes.Interface
	metricsClient metricsv.Interface
	initErr       error
	initOnce      sync.Once
}

func (c *K8sCollector) Name() string { return "k8s" }

func (c *K8sCollector) Collect(ctx context.Context, client *chclient.Client) (*CollectResult, error) {
	start := time.Now()
	result := &CollectResult{}

	if !c.Config.Enabled {
		result.Duration = time.Since(start)
		return result, nil
	}

	if err := c.ensureClients(); err != nil {
		c.logger().Debug("K8s collector disabled: cannot connect to cluster",
			slog.String("error", err.Error()))
		result.Duration = time.Since(start)
		return result, nil // graceful degradation
	}

	// Associate K8s findings with the ClickHouse instance being polled. Using a
	// literal "k8s" here meant the alerter's per-instance store lookup found no
	// client, so the alert was never persisted or shown and PagerDuty re-fired
	// forever with no resolve.
	instance := client.Name()
	c.collectPodStatus(ctx, result, instance)
	c.collectPodMetrics(ctx, result, instance)

	result.Duration = time.Since(start)
	return result, nil
}

// ensureClients lazily creates the Kubernetes and Metrics API clients.
func (c *K8sCollector) ensureClients() error {
	c.initOnce.Do(func() {
		c.initErr = c.doInitClients()
	})
	return c.initErr
}

func (c *K8sCollector) doInitClients() error {
	cfg, err := rest.InClusterConfig()
	if err != nil {
		// Fall back to kubeconfig (for local development).
		loadingRules := clientcmd.NewDefaultClientConfigLoadingRules()
		configOverrides := &clientcmd.ConfigOverrides{}
		cfg, err = clientcmd.NewNonInteractiveDeferredLoadingClientConfig(
			loadingRules, configOverrides).ClientConfig()
		if err != nil {
			return fmt.Errorf("no K8s config available: %w", err)
		}
	}

	cfg.Timeout = 10 * time.Second

	c.kubeClient, err = kubernetes.NewForConfig(cfg)
	if err != nil {
		return fmt.Errorf("creating k8s client: %w", err)
	}

	c.metricsClient, err = metricsv.NewForConfig(cfg)
	if err != nil {
		return fmt.Errorf("creating metrics client: %w", err)
	}

	return nil
}

// collectPodStatus queries the K8s API for pod status: restarts, OOMKills,
// container states, and resource limits.
func (c *K8sCollector) collectPodStatus(ctx context.Context, result *CollectResult, instance string) {
	namespace := c.Config.Namespace
	if namespace == "" {
		namespace = "default"
	}

	listOpts := metav1.ListOptions{}
	if c.Config.LabelSelector != "" {
		listOpts.LabelSelector = c.Config.LabelSelector
	}

	if c.kubeClient == nil {
		return
	}
	pods, err := c.kubeClient.CoreV1().Pods(namespace).List(ctx, listOpts)
	if err != nil {
		c.logger().Warn("failed to list K8s pods", slog.String("error", err.Error()))
		return
	}

	result.AddMetric(instance, "k8s.pods.count", float64(len(pods.Items)), map[string]string{
		"namespace": namespace,
	})

	for _, pod := range pods.Items {
		podName := pod.Name
		podLabels := map[string]string{
			"pod":       podName,
			"namespace": namespace,
		}

		// Phase
		phase := string(pod.Status.Phase)
		running := 0.0
		if phase == "Running" {
			running = 1.0
		}
		result.AddMetric(instance, "k8s.pod.running", running, podLabels)

		for _, cs := range pod.Status.ContainerStatuses {
			cLabels := map[string]string{
				"pod":       podName,
				"namespace": namespace,
				"container": cs.Name,
			}

			restarts := float64(cs.RestartCount)
			result.AddMetric(instance, "k8s.container.restarts", restarts, cLabels)

			if restarts > 5 {
				result.AddAlert(instance, SeverityWarn, "k8s",
					"Container restart count high",
					fmt.Sprintf("Pod %s container %s has %d restarts",
						podName, cs.Name, cs.RestartCount),
					fmt.Sprintf("k8s:restarts:%s:%s", podName, cs.Name))
			}

			// Detect OOMKilled.
			if isOOMKilled(cs) {
				result.AddMetric(instance, "k8s.container.oomkill", 1, cLabels)
				result.AddAlert(instance, SeverityCritical, "k8s",
					"Container OOMKilled",
					fmt.Sprintf("Pod %s container %s was OOMKilled (restarts: %d)",
						podName, cs.Name, cs.RestartCount),
					fmt.Sprintf("k8s:oomkill:%s:%s", podName, cs.Name))
			}
		}

		// Resource limits vs requests.
		for _, container := range pod.Spec.Containers {
			cLabels := map[string]string{
				"pod":       podName,
				"namespace": namespace,
				"container": container.Name,
			}

			if limMem, ok := container.Resources.Limits[corev1.ResourceMemory]; ok {
				result.AddMetric(instance, "k8s.container.limit.memory_bytes",
					float64(limMem.Value()), cLabels)
			}
			if limCPU, ok := container.Resources.Limits[corev1.ResourceCPU]; ok {
				result.AddMetric(instance, "k8s.container.limit.cpu_millicores",
					float64(limCPU.MilliValue()), cLabels)
			}
			if reqMem, ok := container.Resources.Requests[corev1.ResourceMemory]; ok {
				result.AddMetric(instance, "k8s.container.request.memory_bytes",
					float64(reqMem.Value()), cLabels)
			}
			if reqCPU, ok := container.Resources.Requests[corev1.ResourceCPU]; ok {
				result.AddMetric(instance, "k8s.container.request.cpu_millicores",
					float64(reqCPU.MilliValue()), cLabels)
			}
		}
	}
}

// collectPodMetrics queries the Metrics API (metrics.k8s.io) for live
// resource usage of ClickHouse pods.
func (c *K8sCollector) collectPodMetrics(ctx context.Context, result *CollectResult, instance string) {
	namespace := c.Config.Namespace
	if namespace == "" {
		namespace = "default"
	}

	listOpts := metav1.ListOptions{}
	if c.Config.LabelSelector != "" {
		listOpts.LabelSelector = c.Config.LabelSelector
	}

	if c.metricsClient == nil {
		return
	}
	podMetrics, err := c.metricsClient.MetricsV1beta1().PodMetricses(namespace).List(ctx, listOpts)
	if err != nil {
		c.logger().Warn("failed to query K8s pod metrics (metrics-server may not be installed)",
			slog.String("error", err.Error()))
		return
	}

	for _, pm := range podMetrics.Items {
		podName := pm.Name
		for _, cm := range pm.Containers {
			cLabels := map[string]string{
				"pod":       podName,
				"namespace": namespace,
				"container": cm.Name,
			}

			cpuNano := cm.Usage.Cpu().MilliValue()
			memBytes := cm.Usage.Memory().Value()

			result.AddMetric(instance, "k8s.container.usage.cpu_millicores",
				float64(cpuNano), cLabels)
			result.AddMetric(instance, "k8s.container.usage.memory_bytes",
				float64(memBytes), cLabels)
		}
	}
}

// isOOMKilled checks the last termination state for OOMKilled reason.
func isOOMKilled(cs corev1.ContainerStatus) bool {
	if cs.LastTerminationState.Terminated != nil {
		return cs.LastTerminationState.Terminated.Reason == "OOMKilled"
	}
	return false
}

func (c *K8sCollector) logger() *slog.Logger {
	if c.Logger != nil {
		return c.Logger
	}
	return slog.Default()
}
