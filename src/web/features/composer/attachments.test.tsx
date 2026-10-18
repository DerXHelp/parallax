import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LIMITS } from '@shared/common';
import { makeError, type ErrorPayload } from '@shared/errors';
import type { BlobRef } from '@shared/model';
import { sampleBlobId, sampleBlobRef } from '@shared/samples';
import { clientStore, resetClientStore } from '@web/state/store';
import { DEMO_ENTRIES } from '../decisions/lib/demo-data';
import { renderWithHost, type Harness } from '../decisions/lib/testing';
import { Composer } from './Composer';
import type { DecodedImage } from './lib/images';
import { setAttachmentUploader, UploadError } from './lib/upload';
import { resetAttachments, setImageDecoder } from './state/attachments';
import { resetDraftStore } from './state/drafts';

vi.setConfig({ testTimeout: 60_000 });

let harness: Harness | null = null;

afterEach(() => {
  harness?.stop();
  harness = null;
  setAttachmentUploader(null);
  resetAttachments();
  resetClientStore();
  resetDraftStore();
  localStorage.clear();
});

/** Decoder of small images (no scaling needed): the picked file is uploaded as it is. */
function smallImages(): void {
  setImageDecoder((): Promise<DecodedImage> =>
    Promise.resolve({
      width: 640,
      height: 480,
      close: () => undefined,
      encode: () => Promise.resolve(null),
    }),
  );
}

interface PendingUpload {
  name: string;
  resolve(ref: BlobRef): void;
  reject(error: ErrorPayload): void;
}

/** Uploads that wait until the test settles them. */
function controlledUploads(): PendingUpload[] {
  const pending: PendingUpload[] = [];
  setAttachmentUploader(
    (image) =>
      new Promise<BlobRef>((resolve, reject) => {
        pending.push({
          name: image.name,
          resolve,
          reject: (error) => {
            reject(new UploadError(error));
          },
        });
      }),
  );
  return pending;
}

function png(name: string): File {
  return new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], name, { type: 'image/png' });
}

function start(options: { onCommand?: Parameters<typeof renderWithHost>[1]['onCommand'] } = {}): Harness {
  harness = renderWithHost((key) => <Composer sessionKey={key('idle')} />, {
    entries: ['idle'],
    onCommand: options.onCommand,
  });
  return harness;
}

function textbox(): HTMLTextAreaElement {
  return screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message to Claude' });
}

function sendButton(): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>('button', { name: 'Send' });
}

function chips(): HTMLElement[] {
  const list = screen.queryByRole('list', { name: 'Attached images' });
  return list === null ? [] : within(list).getAllByRole('listitem');
}

function paste(files: File[], text = '') {
  fireEvent.paste(textbox(), {
    clipboardData: {
      items: files.map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file })),
      types: files.length > 0 ? ['Files'] : ['text/plain'],
      getData: (type: string) => (type === 'text/plain' ? text : ''),
    },
  });
}

function blob(n: number, name: string): BlobRef {
  return sampleBlobRef({ blobId: sampleBlobId(n), name, width: 640, height: 480 });
}

describe('image attachments (ADR-103, WP-37 §4)', () => {
  it('paste: chip with preview and progress; Send waits for the upload and sends the blob id without text', async () => {
    smallImages();
    const uploads = controlledUploads();
    const h = start();
    paste([png('image.png')]);
    await waitFor(() => {
      expect(chips()[0]?.getAttribute('data-status')).toBe('uploading');
    });
    const chip = chips()[0];
    if (chip === undefined) throw new Error('no chip');
    expect(within(chip).getByText('image.png')).toBeTruthy();
    expect(within(chip).getByRole('group', { name: 'image.png: Uploading…' })).toBeTruthy();
    expect(chip.querySelector('img')?.getAttribute('src')).toMatch(/^blob:/);
    expect(sendButton().disabled).toBe(true);
    expect(screen.getByText('Uploading images…')).toBeTruthy();
    // Enter does not send while the upload runs.
    const user = userEvent.setup();
    await user.type(textbox(), 'look at this');
    await user.keyboard('{Enter}');
    expect(h.commands('session.sendPrompt')).toEqual([]);
    act(() => {
      uploads[0]?.resolve(blob(1, 'image.png'));
    });
    await waitFor(() => {
      expect(chips()[0]?.getAttribute('data-status')).toBe('done');
    });
    await user.clear(textbox());
    expect(sendButton().disabled).toBe(false);
    await user.click(sendButton());
    expect(h.commands('session.sendPrompt')).toEqual([
      {
        name: 'session.sendPrompt',
        entryId: DEMO_ENTRIES.idle,
        prompt: { text: '', attachments: [{ blobId: sampleBlobId(1) }] },
        priority: 'next',
      },
    ]);
    await waitFor(() => {
      expect(chips()).toEqual([]);
    });
  });

  it('a paste with text stays a text paste; other files: "only images"', () => {
    smallImages();
    controlledUploads();
    start();
    paste([png('chart.png')], 'cell A1');
    expect(chips()).toEqual([]);
    paste([new File(['x'], 'notes.txt', { type: 'text/plain' })]);
    expect(chips()).toEqual([]);
    expect(clientStore.getState().notices.map((notice) => notice.content)).toEqual([
      { text: 'composer.attachments.onlyImages' },
    ]);
  });

  it('drop and paper clip; 413/415 show on the chip and block sending until removed (button, Delete)', async () => {
    smallImages();
    const uploads = controlledUploads();
    const h = start();
    const user = userEvent.setup();
    const root = document.querySelector<HTMLElement>('[data-slot="composer"]');
    if (root === null) throw new Error('no composer');
    fireEvent.dragEnter(root, { dataTransfer: { types: ['Files'], files: [] } });
    expect(document.querySelector('[data-slot="drop-target"]')?.textContent).toBe(
      'Drop images to attach them',
    );
    fireEvent.drop(root, { dataTransfer: { types: ['Files'], files: [png('big.png')] } });
    expect(document.querySelector('[data-slot="drop-target"]')).toBeNull();
    const input = document.querySelector<HTMLInputElement>('[data-slot="attach-input"]');
    if (input === null) throw new Error('no file input');
    expect(input.accept).toBe('image/png,image/jpeg,image/webp,image/gif');
    await user.upload(input, png('odd.png'));
    await waitFor(() => {
      expect(uploads).toHaveLength(2);
    });
    act(() => {
      uploads[0]?.reject(makeError('PAYLOAD_TOO_LARGE'));
      uploads[1]?.reject(makeError('UNSUPPORTED_MEDIA_TYPE'));
    });
    await waitFor(() => {
      expect(chips().map((chip) => chip.getAttribute('data-status'))).toEqual(['error', 'error']);
    });
    expect(within(chips()[0] ?? document.body).getByText('The data is too large.')).toBeTruthy();
    expect(within(chips()[1] ?? document.body).getByText('This file type is not supported.')).toBeTruthy();
    await user.type(textbox(), 'two images');
    expect(sendButton().disabled).toBe(true);
    expect(screen.getByText('Remove the failed image to send.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Remove big.png' }));
    expect(chips()).toHaveLength(1);
    const focusable = screen.getByRole('group', { name: 'odd.png: Failed' });
    focusable.focus();
    await user.keyboard('{Delete}');
    expect(chips()).toEqual([]);
    await waitFor(() => {
      expect(document.activeElement).toBe(textbox());
    });
    expect(sendButton().disabled).toBe(false);
    await user.keyboard('{Enter}');
    expect(h.commands('session.sendPrompt').map((cmd) => cmd.prompt)).toEqual([
      { text: 'two images', attachments: [] },
    ]);
  });

  it('a failed send brings text and images back', async () => {
    smallImages();
    const uploads = controlledUploads();
    const h = start({
      onCommand: (cmd) =>
        cmd.name === 'session.sendPrompt' ? { ok: false, error: makeError('SESSION_BUSY') } : undefined,
    });
    paste([png('a.png')]);
    await waitFor(() => {
      expect(uploads).toHaveLength(1);
    });
    act(() => {
      uploads[0]?.resolve(blob(2, 'a.png'));
    });
    const user = userEvent.setup();
    await user.type(textbox(), 'with picture{Enter}');
    await waitFor(() => {
      expect(textbox().value).toBe('with picture');
    });
    expect(chips().map((chip) => chip.getAttribute('data-status'))).toEqual(['done']);
    expect(h.commands('session.sendPrompt')[0]?.prompt.attachments).toEqual([{ blobId: sampleBlobId(2) }]);
  });

  it(`takes at most ${String(LIMITS.attachmentsMax)} images and says so`, () => {
    smallImages();
    controlledUploads();
    start();
    paste(Array.from({ length: LIMITS.attachmentsMax + 1 }, (_, i) => png(`shot-${String(i)}.png`)));
    expect(chips()).toHaveLength(LIMITS.attachmentsMax);
    expect(clientStore.getState().notices.map((notice) => notice.content)).toEqual([
      { text: 'composer.attachments.tooMany', params: { max: LIMITS.attachmentsMax } },
    ]);
  });

  it('an unreadable image fails on its chip', async () => {
    setImageDecoder(() => Promise.reject(new Error('corrupt')));
    controlledUploads();
    start();
    paste([png('broken.png')]);
    await waitFor(() => {
      expect(chips()[0]?.getAttribute('data-status')).toBe('error');
    });
    expect(screen.getByText('The image could not be read.')).toBeTruthy();
  });
});
