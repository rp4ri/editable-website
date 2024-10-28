import { getCurrentUser } from '$lib/api';

export async function handle({ event, resolve }) {
  const sessionId = event.cookies.get('sessionid');

  event.locals.user = sessionId ? await getCurrentUser(sessionId) : null;

  const response = await resolve(event);
  return response;
}
