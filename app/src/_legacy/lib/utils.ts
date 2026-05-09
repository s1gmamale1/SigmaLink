import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import type { PTYBridge } from '@/types';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function generateId(): string {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

export function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = ((ms % 60000) / 1000).toFixed(0);
  return `${mins}m ${secs}s`;
}

// Mock PTY bridge for web environment (replaced with real node-pty in Electron)
export function mockPTYBridge(): PTYBridge {
  const dataCallbacks: ((data: string) => void)[] = [];
  const exitCallbacks: ((code: number) => void)[] = [];
  let killed = false;

  // Simulate some initial output
  setTimeout(() => {
    if (!killed) {
      dataCallbacks.forEach(cb => cb('\r\n$ '));
    }
  }, 100);

  return {
    write(data: string) {
      if (killed) return;
      // Echo back typed characters
      if (data === '\r') {
        dataCallbacks.forEach(cb => cb('\r\n'));
        setTimeout(() => {
          if (!killed) {
            dataCallbacks.forEach(cb => cb('$ '));
          }
        }, 50);
      } else if (data === '\x7f') {
        dataCallbacks.forEach(cb => cb('\b \b'));
      } else {
        dataCallbacks.forEach(cb => cb(data));
      }
    },
    resize() {},
    onData(callback: (data: string) => void) {
      dataCallbacks.push(callback);
    },
    onExit(callback: (code: number) => void) {
      exitCallbacks.push(callback);
    },
    kill() {
      killed = true;
      exitCallbacks.forEach(cb => cb(0));
    },
  };
}

// ANSI color code parser for terminal output
export function parseAnsi(text: string): string {
  // Convert ANSI escape codes to HTML spans
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\x1b\[0m/g, '</span>')
    .replace(/\x1b\[1m/g, '<span class="font-bold">')
    .replace(/\x1b\[3m/g, '<span class="italic">')
    .replace(/\x1b\[30m/g, '<span class="text-gray-900">')
    .replace(/\x1b\[31m/g, '<span class="text-red-500">')
    .replace(/\x1b\[32m/g, '<span class="text-green-500">')
    .replace(/\x1b\[33m/g, '<span class="text-yellow-500">')
    .replace(/\x1b\[34m/g, '<span class="text-blue-500">')
    .replace(/\x1b\[35m/g, '<span class="text-purple-500">')
    .replace(/\x1b\[36m/g, '<span class="text-cyan-500">')
    .replace(/\x1b\[37m/g, '<span class="text-gray-100">')
    .replace(/\x1b\[90m/g, '<span class="text-gray-500">')
    .replace(/\x1b\[91m/g, '<span class="text-red-400">')
    .replace(/\x1b\[92m/g, '<span class="text-green-400">')
    .replace(/\x1b\[93m/g, '<span class="text-yellow-400">')
    .replace(/\x1b\[94m/g, '<span class="text-blue-400">')
    .replace(/\x1b\[95m/g, '<span class="text-purple-400">')
    .replace(/\x1b\[96m/g, '<span class="text-cyan-400">')
    .replace(/\x1b\[97m/g, '<span class="text-white">');
}
