import { Platform } from 'react-native';

export type Session = { token: string; user: { id: string; name: string; role: 'manager' | 'guard' } };

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export async function api<T>(path: string, token?: string, input?: object): Promise<T> {
  const base = Platform.OS === 'web' ? '' : process.env.EXPO_PUBLIC_PATROL_API_URL;
  if (base === undefined) throw new Error('Configure the guard app server URL before signing in.');
  const response = await fetch(base + '/api/' + path, {
    method: input ? 'POST' : 'GET',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(input ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(input ? { body: JSON.stringify(input) } : {}),
  });
  const data = await response.json();
  if (!response.ok) throw new ApiError(data.error || 'Request failed.', response.status);
  return data as T;
}
