import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { SendTaskSheet, friendlySendError } from '../../src/renderer/components/SendTaskSheet'
import { ToastProvider } from '../../src/renderer/components/Toast'
import { fixtures, installMockApi } from './setup'

function renderSheet(initialTarget?: string) {
  const mock = installMockApi()
  const onClose = vi.fn()
  render(
    <ToastProvider>
      <SendTaskSheet open nodes={fixtures.nodes().nodes} initialTarget={initialTarget} onClose={onClose} />
    </ToastProvider>
  )
  return { mock, onClose }
}

describe('Send task sheet', () => {
  it('sends a task with optional code to the chosen node', async () => {
    const { mock, onClose } = renderSheet('Desktop-PC')
    expect(screen.getByRole('dialog', { name: 'Send a task' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /Desktop-PC/ })).toBeChecked()
    expect(screen.getByRole('radio', { name: /Studio-Mac/ })).toBeDisabled()
    await userEvent.type(screen.getByLabelText('What should it do?'), 'Run the tests')
    await userEvent.click(screen.getByRole('button', { name: /Add code/ }))
    await userEvent.type(screen.getByLabelText(/Code/), 'print(1)')
    await userEvent.click(screen.getByRole('button', { name: 'Send to Desktop-PC' }))
    expect(mock.api.backend.sendTask).toHaveBeenCalledWith({
      target_hostname: 'Desktop-PC',
      task_description: 'Run the tests',
      code_payload: 'print(1)'
    })
    expect(onClose).toHaveBeenCalled()
  })

  it('shows a friendly inline error when the node is unreachable', async () => {
    const { mock } = renderSheet('MacBook')
    vi.mocked(mock.api.backend.sendTask).mockResolvedValueOnce({ ok: false, error: 'connect timeout (502)' })
    await userEvent.type(screen.getByLabelText('What should it do?'), 'Hello')
    await userEvent.click(screen.getByRole('button', { name: 'Send to MacBook' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t reach MacBook — is it awake and running AirBridge?')
  })

  it('closes on Escape', async () => {
    const { onClose } = renderSheet()
    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalled()
  })

  it('maps raw errors to plain language', () => {
    expect(friendlySendError('413 payload too large', 'X')).toMatch(/too big/)
    expect(friendlySendError('429', 'X')).toMatch(/wait a few seconds/)
  })
})
