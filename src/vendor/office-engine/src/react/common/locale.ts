import { useMemo } from 'react'
import { inputLocale } from '../../core/number-input'
import { useStrings } from '../strings'

/** The resolved UI locale for numeric input. Missing or unsupported tags use the engine's default number syntax. */
export function useLocale() {
  const { locale } = useStrings()
  return useMemo(() => inputLocale(locale), [locale])
}
