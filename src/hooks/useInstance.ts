import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { InstanceResponse } from '../types/api';

/** A web address the server sent, or null: only http(s) ever becomes a link. */
const webAddress = (value: unknown) => (typeof value === 'string' && /^https?:\/\//.test(value) ? value : null);

/**
 * What this install offers before anyone signs in, according to the server. Demo mode stays on
 * unless the server says it's off: with no server at all (`npm run demo`), it's all there is.
 * The note is the install's own words, shown as text; the terms and privacy notice are its own
 * pages, linked.
 */
export function useInstance(): InstanceResponse | null {
  const [instance, setInstance] = useState<InstanceResponse | null>(null);
  useEffect(() => {
    api<Partial<InstanceResponse>>('/api/instance')
      .catch(() => ({}) as Partial<InstanceResponse>)
      .then((body) =>
        setInstance({
          demo: body.demo !== false,
          note: typeof body.note === 'string' && body.note ? body.note : null,
          terms: webAddress(body.terms),
          privacy: webAddress(body.privacy),
        }),
      );
  }, []);
  return instance;
}
