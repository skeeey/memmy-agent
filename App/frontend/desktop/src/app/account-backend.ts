/** Account backend module. */

/**
 * Whether this build signs users in against cuberouter.
 *
 * Build-time, like MEMMY_APP_EDITION: it describes what the build ships, not what the
 * current session is doing — the question it answers is "does this product hand out
 * memmy platform accounts", which is not knowable from a session that does not exist yet.
 *
 * Defaults to cuberouter because that is the only sign-in this branch has. The
 * memmy-cloud affordances gated behind it — the sign-up gift banner and the "no
 * registration needed" bypass — both promise a platform account, and a cuberouter
 * identity cannot be issued one: the cloud refuses the JWT it holds, so the gift the
 * banner advertises can never be granted.
 *
 * Set MEMMY_ACCOUNT_BACKEND=memmy_cloud to bring them back.
 */
export function isCuberouterAccountBackend(): boolean {
  return (import.meta.env.MEMMY_ACCOUNT_BACKEND as string | undefined) !== "memmy_cloud";
}
