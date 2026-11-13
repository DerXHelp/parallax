import { useReturnFocus } from '@web/lib/return-focus';
import { Button } from '@web/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@web/ui/dialog';
import { useStyleT } from './i18n';
import { OutputStylePicker } from './OutputStylePicker';

/**
 * WP-70: "Output style…" of the header "…" menu (a lazy chunk, mounted by the NavigationLayer for
 * the shell request `outputStyle`): the styles of the session's project and where the choice is
 * kept (`.claude\settings.local.json`, every session of the project, from the next turn).
 */
export function OutputStyleDialog({ sessionKey, onClose }: { sessionKey: string; onClose: () => void }) {
  const st = useStyleT();
  const onCloseAutoFocus = useReturnFocus(true);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        data-slot="output-style-dialog"
        className="sm:max-w-sm"
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <DialogHeader>
          <DialogTitle>{st('title')}</DialogTitle>
          <DialogDescription>{st('hint')}</DialogDescription>
        </DialogHeader>
        <OutputStylePicker sessionKey={sessionKey} />
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {st('close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
