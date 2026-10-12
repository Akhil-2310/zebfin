// Separate ZIP 32 accounts from one seed: each has its own addresses, balance
// and viewing key, so sharing one account's viewing key reveals nothing else.

import { post } from "./api";
import { saveRecord, type AccountLabel, type Stored } from "./records";
import type { Session } from "./session";
import { exportAccount, storeSigningKey, unwrapSeedWithPasskey } from "./signer";

/** Creates the next account from the seed behind `fromAccountId` (one or two passkey prompts). */
export async function createSiblingAccount(
  session: Session,
  fromAccountId: string,
  name: string,
  labels: Stored<AccountLabel>[],
): Promise<string> {
  const seed = await unwrapSeedWithPasskey(session, fromAccountId);
  const fp = labels.find((l) => l.value.accountId === fromAccountId)?.value.seedFingerprint;
  const used = labels.filter((l) => l.value.seedFingerprint === fp).map((l) => l.value.accountIndex ?? 0);
  const index = Math.max(seed.accountIndex, ...used) + 1;
  const exp = await exportAccount(seed.mnemonic, index);
  const { account_id } = await post<{ account_id: string }>(
    "/v1/accounts",
    { ufvk: exp.ufvk, seed_fingerprint: exp.seed_fingerprint, account_index: index, birthday: null },
    session.token,
  );
  await saveRecord(session, { type: "account", accountId: account_id, name, seedFingerprint: exp.seed_fingerprint, accountIndex: index });
  await storeSigningKey(session, account_id, { mnemonic: seed.mnemonic, accountIndex: index });
  return account_id;
}
