import { useCallback, useState } from 'react'
import { useToast } from '../components/Toast'
import { api, errorText } from './api'

/** Start the browser sign-in from anywhere in the app; failures become a toast. */
export function useSignIn(): { busy: boolean; signIn: () => Promise<void> } {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const signIn = useCallback(async () => {
    setBusy(true)
    try {
      await api().auth.signIn()
    } catch (err) {
      toast.show({ tone: 'error', title: 'Couldn’t start sign-in', body: errorText(err) })
    } finally {
      setBusy(false)
    }
  }, [toast])
  return { busy, signIn }
}
