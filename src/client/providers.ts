/**
 * The provider directory this page reads, and which rows of it are worth
 * offering.
 *
 * Both halves of the plugin import from here — the apply half for its wire
 * declarations, the panel for the filter its first read runs — so the row shape
 * has one home and neither half imports the other for it.
 */

/**
 * Wire view of one configurable provider, mirroring the host's
 * `ConfigurableProviderView`.
 *
 * The host's published contracts resolve to `any` outside the harness repo's
 * source-level `paths` facade (their `.d.ts` import relatively with `.ts`
 * extensions), and this plugin repo deliberately carries no facade. Declaring
 * the shapes this page consumes keeps its own logic checked here instead of
 * silently untyped.
 */
export interface ProviderRow {
  provider: string
  displayName: string
  settingsNs: string
  settingsPath: string[]
  active: boolean
  declared?: boolean
}

/**
 * The providers this page may offer, in directory order.
 *
 * `active` means the route is registered with the adapter registry, which only
 * happens once a settings profile declared it, so an inactive route is one the
 * user never configured. `settingsNs` addresses the profile the capability
 * controls write into, and the host leaves it empty for a route registered
 * without a directory declaration. The host answers with the whole directory, so
 * a page that offered every row would show providers this deployment cannot
 * reach.
 * @param rows - every provider row the host reported.
 * @returns the configured rows, in the order the host listed them.
 */
export function configuredProviders(rows: readonly ProviderRow[]): ProviderRow[] {
  return rows.filter(row => row.active && row.settingsNs !== '')
}
