import { useT } from '@web/i18n';

/**
 * Part "Control others" of the section "Several computers" – the place WP-80 fills (list of
 * sharing computers with `hosts.*`: add with pairing code, rename, color, order, remove,
 * reconnect). Until then a placeholder; the role switch itself already works.
 */
export function ControlPart() {
  const t = useT();
  return (
    <p data-slot="multi-host-control" className="text-muted-foreground text-xs leading-relaxed">
      {t('preferences.multiHost.control.placeholder')}
    </p>
  );
}
