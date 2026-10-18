import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { InstanceResponse } from '../types/api';

/**
 * What this install offers before anyone signs in, according to the server. Demo mode stays on
 * unless the server says it's off: with no server at all (`npm run demo`), it's all there is.
 * The note is the install's own words, shown as text.
 */
export function useInstance(): InstanceResponse | null {
  const [instance, setInstance] = useState<InstanceResponse | null>(null);
  useEffect(() => {
    api<Partial<InstanceResponse>>('/api/instance')
      .catch(() => ({}) as Partial<InstanceResponse>)
      .then((body) => setInstance({ demo: body.demo !== false, note: typeof body.note === 'string' && body.note ? body.note : null }));
  }, []);
  return instance;
}
