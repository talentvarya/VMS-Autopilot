'use client';

import FlyerGenerator from './social/FlyerGenerator';
import SocialSuperAgent from './social/SocialSuperAgent';
import type { RealClient } from './social/Composer';

/**
 * Phase G.15 - the owner asked for the sandbox post-lifecycle demo (invented clients/channels,
 * draft -> approve -> schedule -> "publish" over fake data) removed from this page, now that
 * real content tools cover what it used to demonstrate: AI flyers and an AI content calendar
 * (below), and real Buffer account insights (the separate Connected Accounts page).
 *
 * The sandbox itself (lib/social/*, and its own components/tests) is left untouched - only this
 * page's use of it was removed, so it stays easy to bring back if ever wanted again.
 */
export default function SocialModule({ notify, realClients = [] }: { notify: (text: string) => void; realClients?: RealClient[] }) {
  return (
    <div className="soc">
      <FlyerGenerator realClients={realClients} notify={notify} />
      <SocialSuperAgent realClients={realClients} notify={notify} />
    </div>
  );
}
