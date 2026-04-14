package alerter

import (
	"fmt"
	"log/slog"

	"github.com/slack-go/slack"
)

// PostEscalationNotice posts a short new Slack message (not an update) indicating
// that the given instance has been firing for firingMinutes without a response.
func (s *SlackNotifier) PostEscalationNotice(instance string, firingMinutes int) error {
	text := fmt.Sprintf(
		":alarm_clock: *Escalation* — `%s` has been firing for %d minutes with no response.",
		instance, firingMinutes,
	)

	blocks := []slack.Block{
		slack.NewSectionBlock(
			slack.NewTextBlockObject(slack.MarkdownType, text, false, false),
			nil, nil,
		),
	}

	attachment := slack.Attachment{
		Color:  colorRed,
		Blocks: slack.Blocks{BlockSet: blocks},
	}

	err := s.postMessage(
		slack.MsgOptionAttachments(attachment),
		slack.MsgOptionText(fmt.Sprintf("Escalation — %s has been firing for %d minutes", instance, firingMinutes), false),
	)
	if err != nil {
		s.logger.Error("failed to post escalation notice",
			slog.String("instance", instance),
			slog.Int("firing_minutes", firingMinutes),
			slog.String("error", err.Error()),
		)
		return err
	}
	s.logger.Info("escalation notice posted",
		slog.String("instance", instance),
		slog.Int("firing_minutes", firingMinutes),
	)
	return nil
}
