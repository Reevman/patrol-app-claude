import { Platform } from 'react-native';

export type Session = { token: string; user: { id: string; name: string; role: 'manager' | 'guard' } };

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

const REQUEST_TIMEOUT_MS = 15000;

export async function api<T>(path: string, token?: string, input?: object): Promise<T> {
  const configured = process.env.EXPO_PUBLIC_PATROL_API_URL?.trim().replace(/\/+$/, '');
  if (Platform.OS !== 'web' && !configured) {
    throw new Error('Configure the guard app server URL before signing in.');
  }
  const base = Platform.OS === 'web' ? '' : configured;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(base + '/api/' + path, {
      method: input ? 'POST' : 'GET',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(input ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(input ? { body: JSON.stringify(input) } : {}),
      signal: controller.signal,
    });
  } catch {
    throw new ApiError('Cannot reach the server. Check your connection and try again.', 0);
  } finally {
    clearTimeout(timer);
  }

  const data = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(data?.error || 'Request failed.', response.status);
  if (data === null) throw new ApiError('The server sent an unexpected response.', response.status);
  return data as T;
}
