import { useEffect, useState } from 'react'

// useDebouncedValue returns `value` but only after it has stayed unchanged
// for `delayMs`. Designed for filter inputs that drive expensive API calls:
// the parent renders with `raw` (so the textbox is responsive) and uses the
// debounced value as the API key, avoiding one call per keystroke.
export function useDebouncedValue<T>(value: T, delayMs = 250): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(id)
  }, [value, delayMs])
  return debounced
}
