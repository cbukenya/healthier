import { CircleDotDashed, FlaskConical, Footprints, Heart, Moon, PersonStanding, User, Utensils, type LucideIcon } from 'lucide-react';
import type { MessageKey } from '../i18n';
import { DOMAIN } from './primitives';

/** The pages in the bar, in their first order. Settings is the gear beside them, not one of them. */
export const PAGES = ['today', 'activity', 'sleep', 'vitals', 'body', 'nutrition', 'cycle', 'labs'] as const;
export type PageId = (typeof PAGES)[number];

/** Each page's name, icon and colour, for the bar and for Settings › Customization. Today's is the plain one. */
export const PAGE_LOOK: Record<PageId, { label: MessageKey; icon: LucideIcon; color?: string }> = {
  today: { label: 'app.nav.today', icon: User },
  activity: { label: 'app.nav.activity', icon: Footprints, color: DOMAIN.movement.text },
  sleep: { label: 'app.nav.sleep', icon: Moon, color: DOMAIN.sleep.text },
  vitals: { label: 'app.nav.vitals', icon: Heart, color: DOMAIN.cardio.text },
  body: { label: 'app.nav.body', icon: PersonStanding, color: DOMAIN.body.text },
  nutrition: { label: 'app.nav.nutrition', icon: Utensils, color: DOMAIN.nutrition.text },
  cycle: { label: 'app.nav.cycle', icon: CircleDotDashed, color: DOMAIN.cycle.text },
  labs: { label: 'app.nav.labs', icon: FlaskConical, color: 'text-yellow-400' },
};
