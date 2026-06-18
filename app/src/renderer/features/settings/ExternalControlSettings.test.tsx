// @vitest-environment jsdom
//
// ExternalControlSettings + ControlEscalationPrompt tests.
// Covers: enable toggle, freeze toggle, rotate token, escalation approve/deny.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ControlStatus } from '@/shared/router-shape';

// --- mocks -----------------------------------------------------------------

const defaultStatus: ControlStatus = {
  enabled: false,
  frozen: false,
  liveConnections: 0,
  socketPath: '/tmp/sigma-control.sock',
  connectCommand: 'claude mcp add sigma --token abc123',
};

const controlMocks = {
  status: vi.fn(async (): Promise<ControlStatus> => ({ ...defaultStatus })),
  enable: vi.fn(async (): Promise<ControlStatus> => ({ ...defaultStatus, enabled: true })),
  disable: vi.fn(async (): Promise<ControlStatus> => ({ ...defaultStatus, enabled: false })),
  freeze: vi.fn(async (): Promise<ControlStatus> => ({ ...defaultStatus, enabled: true, frozen: true })),
  unfreeze: vi.fn(async (): Promise<ControlStatus> => ({ ...defaultStatus, enabled: true, frozen: false })),
  rotateToken: vi.fn(async (): Promise<ControlStatus> => ({
    ...defaultStatus,
    enabled: true,
    connectCommand: 'claude mcp add sigma --token newtoken',
  })),
  connectCommand: vi.fn(async () => ({ command: defaultStatus.connectCommand })),
  respondEscalation: vi.fn(async () => ({ ok: true })),
};

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: { control: controlMocks },
}));

// Stub navigator.clipboard
Object.assign(navigator, {
  clipboard: { writeText: vi.fn(async () => undefined) },
});

// Mock window.sigma for use-control-escalation
type EventHandler = (payload: unknown) => void;
let capturedEventHandlers: Record<string, EventHandler> = {};

function setupSigmaEventBridge() {
  capturedEventHandlers = {};
  Object.defineProperty(window, 'sigma', {
    value: {
      eventOn: vi.fn((event: string, cb: EventHandler) => {
        capturedEventHandlers[event] = cb;
        return () => {
          delete capturedEventHandlers[event];
        };
      }),
      invoke: vi.fn(),
      eventSend: vi.fn(),
    },
    writable: true,
    configurable: true,
  });
}

function fireEscalationEvent(payload: unknown) {
  const handler = capturedEventHandlers['control:escalation'];
  if (handler) handler(payload);
}

// ---------------------------------------------------------------------------

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  setupSigmaEventBridge();
  controlMocks.status.mockResolvedValue({ ...defaultStatus });
});

// ---------------------------------------------------------------------------
// ExternalControlSettings
// ---------------------------------------------------------------------------

describe('ExternalControlSettings', () => {
  async function renderSettings() {
    const { ExternalControlSettings } = await import('./ExternalControlSettings');
    render(<ExternalControlSettings />);
    await screen.findByTestId('external-control-settings');
  }

  it('renders the settings panel after loading', async () => {
    await renderSettings();
    expect(screen.getByTestId('external-control-settings')).toBeDefined();
  });

  it('Enable toggle calls rpc.control.enable when turned on', async () => {
    await renderSettings();
    const toggle = screen.getByTestId('control-enable-switch');
    fireEvent.click(toggle);
    await waitFor(() => expect(controlMocks.enable).toHaveBeenCalledTimes(1));
  });

  it('Enable toggle calls rpc.control.disable when turned off with enabled status', async () => {
    controlMocks.status.mockResolvedValue({ ...defaultStatus, enabled: true });
    await renderSettings();
    const toggle = screen.getByTestId('control-enable-switch');
    fireEvent.click(toggle);
    await waitFor(() => expect(controlMocks.disable).toHaveBeenCalledTimes(1));
  });

  it('Freeze switch calls rpc.control.freeze when toggled on', async () => {
    controlMocks.status.mockResolvedValue({ ...defaultStatus, enabled: true });
    await renderSettings();
    const freezeSwitch = screen.getByTestId('control-freeze-switch');
    fireEvent.click(freezeSwitch);
    await waitFor(() => expect(controlMocks.freeze).toHaveBeenCalledTimes(1));
  });

  it('Rotate token calls rpc.control.rotateToken', async () => {
    controlMocks.status.mockResolvedValue({ ...defaultStatus, enabled: true });
    await renderSettings();
    const btn = screen.getByTestId('control-rotate-token');
    fireEvent.click(btn);
    await waitFor(() => expect(controlMocks.rotateToken).toHaveBeenCalledTimes(1));
  });

  it('displays live connections count', async () => {
    controlMocks.status.mockResolvedValue({ ...defaultStatus, enabled: true, liveConnections: 3 });
    await renderSettings();
    const count = screen.getByTestId('control-live-connections');
    expect(count.textContent).toBe('3');
  });
});

// ---------------------------------------------------------------------------
// ControlEscalationPrompt
// ---------------------------------------------------------------------------

describe('ControlEscalationPrompt', () => {
  async function renderPrompt() {
    const { ControlEscalationPrompt } = await import('./ControlEscalationPrompt');
    render(<ControlEscalationPrompt />);
  }

  it('does not render anything when the queue is empty', async () => {
    await renderPrompt();
    expect(screen.queryByTestId('control-escalation-prompt')).toBeNull();
  });

  it('renders an escalation card when an event is fired', async () => {
    await renderPrompt();
    fireEscalationEvent({
      id: 'esc-1',
      toolName: 'close_pane',
      summary: 'Close the terminal pane',
      clientLabel: 'External Claude',
    });
    await screen.findByTestId('control-escalation-prompt');
    expect(screen.getByText('close_pane')).toBeDefined();
    expect(screen.getByText('External Claude')).toBeDefined();
  });

  it('Approve calls respondEscalation with approved:true and dismisses', async () => {
    await renderPrompt();
    fireEscalationEvent({
      id: 'esc-approve',
      toolName: 'kill_session',
      summary: 'Terminate session',
      clientLabel: 'Agent X',
    });
    await screen.findByTestId('control-escalation-approve');
    fireEvent.click(screen.getByTestId('control-escalation-approve'));
    await waitFor(() =>
      expect(controlMocks.respondEscalation).toHaveBeenCalledWith({
        id: 'esc-approve',
        approved: true,
      }),
    );
    await waitFor(() =>
      expect(screen.queryByTestId('control-escalation-prompt')).toBeNull(),
    );
  });

  it('Deny calls respondEscalation with approved:false and dismisses', async () => {
    await renderPrompt();
    fireEscalationEvent({
      id: 'esc-deny',
      toolName: 'kill_session',
      summary: 'Terminate session',
      clientLabel: 'Agent X',
    });
    await screen.findByTestId('control-escalation-deny');
    fireEvent.click(screen.getByTestId('control-escalation-deny'));
    await waitFor(() =>
      expect(controlMocks.respondEscalation).toHaveBeenCalledWith({
        id: 'esc-deny',
        approved: false,
      }),
    );
    await waitFor(() =>
      expect(screen.queryByTestId('control-escalation-prompt')).toBeNull(),
    );
  });
});
