import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LIMITS } from '@shared/common';
import { makeError, type ErrorPayload } from '@shared/errors';
import type { BlobRef } from '@shared/model';
import { sampleBlobId, sampleBlobRef } from '@shared/samples';
import { requestShell } from '@web/shell/requests';
import { clientStore, resetClientStore } from '@web/state/store';
import { DEMO_ENTRIES } from '../decisions/lib/demo-data';
import { renderWithHost, type Harness } from '../decisions/lib/testing';
import { Composer } from './Composer';
import type { DecodedImage } from './lib/images';
import { setAttachmentUploader, UploadError, type UploadRequest } from './lib/upload';
import {
  attachmentsOverTotal,
  resetAttachments,
  setImageDecoder,
  type ComposerAttachment,
} from './state/attachments';
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
  request: UploadRequest;
  resolve(ref: BlobRef): void;
  reject(error: ErrorPayload): void;
}

/** Uploads that wait until the test settles them. */
function controlledUploads(): PendingUpload[] {
  const pending: PendingUpload[] = [];
  setAttachmentUploader(
    (request) =>
      new Promise<BlobRef>((resolve, reject) => {
        pending.push({
          name: request.name,
          request,
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
  const list = screen.queryByRole('list', { name: 'Attachments' });
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
    expect(screen.getByText('Uploading attachments…')).toBeTruthy();
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
        prompt: { text: '', attachments: [{ blobId: sampleBlobId(1) }], pastes: [] },
        priority: 'next',
      },
    ]);
    await waitFor(() => {
      expect(chips()).toEqual([]);
    });
  });

  it('a paste with text stays a text paste; other files become file chips (ADR-146)', async () => {
    smallImages();
    const uploads = controlledUploads();
    start();
    paste([png('chart.png')], 'cell A1');
    expect(chips()).toEqual([]);
    paste([new File(['x'], 'notes.txt', { type: 'text/plain' })]);
    await waitFor(() => {
      expect(uploads.map((upload) => upload.name)).toEqual(['notes.txt']);
    });
    expect(chips().map((chip) => chip.getAttribute('data-kind'))).toEqual(['file']);
    expect(clientStore.getState().notices).toEqual([]);
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
      'Drop files to attach them',
    );
    fireEvent.drop(root, { dataTransfer: { types: ['Files'], files: [png('big.png')] } });
    expect(document.querySelector('[data-slot="drop-target"]')).toBeNull();
    const input = document.querySelector<HTMLInputElement>('[data-slot="attach-input"]');
    if (input === null) throw new Error('no file input');
    // ADR-146: the paper clip takes any file.
    expect(input.hasAttribute('accept')).toBe(false);
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
    expect(screen.getByText('Remove the failed attachment to send.')).toBeTruthy();
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
      { text: 'two images', attachments: [], pastes: [] },
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

  it('ADR-125: images over the total limit show the error on the chip and block sending until removed', async () => {
    smallImages();
    const uploads = controlledUploads();
    const h = start();
    const perImage = 3_750_000;
    const count = Math.floor(LIMITS.attachmentsTotalBytes / perImage) + 1;
    paste(Array.from({ length: count }, (_, i) => png(`big-${String(i)}.png`)));
    await waitFor(() => {
      expect(uploads).toHaveLength(count);
    });
    act(() => {
      uploads.forEach((upload, i) => {
        upload.resolve({ ...blob(20 + i, upload.name), bytes: perImage });
      });
    });
    await waitFor(() => {
      expect(chips().map((chip) => chip.getAttribute('data-status'))).toEqual(Array(count).fill('done'));
    });
    // Only the last chip crosses the limit (in list order).
    expect(chips().map((chip) => chip.hasAttribute('data-over-total'))).toEqual([
      ...Array<boolean>(count - 1).fill(false),
      true,
    ]);
    const last = chips().at(-1) ?? document.body;
    expect(within(last).getByText('Images and PDFs together over 20 MB')).toBeTruthy();
    expect(
      within(last).getByRole('group', {
        name: `big-${String(count - 1)}.png: Images and PDFs together over 20 MB`,
      }),
    ).toBeTruthy();
    expect(screen.getByText('Images and PDFs are too large together – remove one to send.')).toBeTruthy();
    expect(sendButton().disabled).toBe(true);
    const user = userEvent.setup();
    await user.type(textbox(), 'many screenshots{Enter}');
    expect(h.commands('session.sendPrompt')).toEqual([]);
    await user.click(screen.getByRole('button', { name: `Remove big-${String(count - 1)}.png` }));
    expect(chips().some((chip) => chip.hasAttribute('data-over-total'))).toBe(false);
    expect(sendButton().disabled).toBe(false);
    await user.click(sendButton());
    expect(h.commands('session.sendPrompt')[0]?.prompt.attachments).toHaveLength(count - 1);
  });

  it('attachmentsOverTotal adds the finished uploads in list order', () => {
    const chip = (id: string, bytes: number | null): ComposerAttachment => ({
      id,
      name: `${id}.png`,
      kind: 'image',
      bytes: bytes ?? 0,
      previewUrl: null,
      status: bytes === null ? 'uploading' : 'done',
      failure: null,
      ref: bytes === null ? null : { ...blob(1, `${id}.png`), bytes },
    });
    expect([...attachmentsOverTotal([chip('a', 6), chip('b', null), chip('c', 5)], 10)]).toEqual(['c']);
    expect([...attachmentsOverTotal([chip('a', 11), chip('b', 1)], 10)]).toEqual(['a', 'b']);
    expect(attachmentsOverTotal([chip('a', 10)], 10).size).toBe(0);
  });

  it('R4W-26: "/plan text" waits for running uploads – no mode switch with the text left behind', async () => {
    smallImages();
    const uploads = controlledUploads();
    const h = start();
    paste([png('plan.png')]);
    await waitFor(() => {
      expect(uploads).toHaveLength(1);
    });
    const user = userEvent.setup();
    await user.type(textbox(), '/plan write the tests first');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Run' }).disabled).toBe(true);
    await user.keyboard('{Enter}');
    expect(h.commands('session.setPermissionMode')).toEqual([]);
    expect(textbox().value).toBe('/plan write the tests first');
    expect(screen.getByText('Uploading attachments…')).toBeTruthy();
    act(() => {
      uploads[0]?.resolve(blob(3, 'plan.png'));
    });
    await waitFor(() => {
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Run' }).disabled).toBe(false);
    });
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(h.commands('session.sendPrompt').map((cmd) => cmd.prompt)).toEqual([
        { text: 'write the tests first', attachments: [{ blobId: sampleBlobId(3) }], pastes: [] },
      ]);
    });
    expect(h.commands('session.setPermissionMode').map((cmd) => cmd.mode)).toEqual(['plan']);
  });

  it('R4W-26: while Enter answers a decision, a hint says the images wait for the next message', async () => {
    smallImages();
    controlledUploads();
    harness = renderWithHost((key) => <Composer sessionKey={key('permission')} />, {
      entries: ['permission'],
    });
    await screen.findByText(/Enter denies it with your text/);
    expect(document.querySelector('[data-slot="composer-images-later"]')).toBeNull();
    paste([png('proof.png')]);
    const hint = await screen.findByText(
      'The attachments stay for your next message – an answer is sent without them.',
    );
    expect(textbox().getAttribute('aria-describedby')?.split(' ')).toContain(hint.closest('p')?.id);
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

/** A file that claims `size` bytes (no large buffers in tests). */
function sized(name: string, type: string, size: number): File {
  const file = new File([new Uint8Array([37, 80, 68, 70])], name, { type });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

/** An untyped `File` that cannot be read – how a folder arrives in a plain file list. */
function folderFile(name: string): File {
  const file = new File([], name, { type: '' });
  Object.defineProperty(file, 'slice', {
    value: () => ({ arrayBuffer: () => Promise.reject(new Error('NotReadableError')) }),
  });
  return file;
}

function noticeTexts(): unknown[] {
  return clientStore.getState().notices.map((notice) => notice.content);
}

describe('PDFs and other files (ADR-146, WP-57)', () => {
  it('a PDF goes raw as application/pdf, another file as octet-stream with its name; chips show kind and size', async () => {
    const uploads = controlledUploads();
    const h = start();
    const pdf = sized('Review.pdf', 'application/pdf', 184_320);
    const zip = sized('build.zip', 'application/zip', 2_400_000);
    paste([pdf, zip]);
    await waitFor(() => {
      expect(uploads).toHaveLength(2);
    });
    expect(uploads.map(({ request }) => [request.type, request.name, request.blob, request.width])).toEqual([
      ['application/pdf', 'Review.pdf', pdf, undefined],
      ['application/octet-stream', 'build.zip', zip, undefined],
    ]);
    expect(chips().map((chip) => chip.getAttribute('data-kind'))).toEqual(['pdf', 'file']);
    expect(screen.getByRole('group', { name: 'Review.pdf (PDF, 184 kB): Uploading…' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'build.zip (File, 2.4 MB): Uploading…' })).toBeTruthy();
    expect(chips()[0]?.querySelector('img')).toBeNull();
    act(() => {
      uploads[0]?.resolve(
        sampleBlobRef({
          blobId: sampleBlobId(5),
          mediaType: 'application/pdf',
          bytes: 184_320,
          name: 'Review.pdf',
          width: null,
          height: null,
        }),
      );
      uploads[1]?.resolve(
        sampleBlobRef({
          blobId: sampleBlobId(6),
          mediaType: 'application/octet-stream',
          bytes: 2_400_000,
          name: 'build.zip',
          width: null,
          height: null,
        }),
      );
    });
    await waitFor(() => {
      expect(sendButton().disabled).toBe(false);
    });
    await userEvent.setup().click(sendButton());
    expect(h.commands('session.sendPrompt')[0]?.prompt.attachments).toEqual([
      { blobId: sampleBlobId(5) },
      { blobId: sampleBlobId(6) },
    ]);
  });

  it('over its limit a PDF or file is an error chip without an upload; 413/415 show on the chip', async () => {
    const uploads = controlledUploads();
    start();
    paste([
      sized('scan.pdf', 'application/pdf', LIMITS.pdfBytes + 1),
      sized('dump.bin', '', LIMITS.fileAttachmentBytes + 1),
      sized('ok.pdf', 'application/pdf', LIMITS.pdfBytes),
      sized('odd.bin', 'application/x-thing', 10),
    ]);
    await waitFor(() => {
      expect(uploads.map((upload) => upload.name)).toEqual(['ok.pdf', 'odd.bin']);
    });
    expect(chips().map((chip) => chip.getAttribute('data-status'))).toEqual([
      'error',
      'error',
      'uploading',
      'uploading',
    ]);
    expect(within(chips()[0] ?? document.body).getByText('File too large (max. 10 MB)')).toBeTruthy();
    expect(within(chips()[1] ?? document.body).getByText('File too large (max. 10 MB)')).toBeTruthy();
    act(() => {
      uploads[0]?.reject(makeError('PAYLOAD_TOO_LARGE'));
      uploads[1]?.reject(makeError('UNSUPPORTED_MEDIA_TYPE'));
    });
    await waitFor(() => {
      expect(within(chips()[2] ?? document.body).getByText('The data is too large.')).toBeTruthy();
    });
    expect(within(chips()[3] ?? document.body).getByText('This file type is not supported.')).toBeTruthy();
    expect(screen.getByText('Remove the failed attachment to send.')).toBeTruthy();
  });

  it('a dropped folder is left out with a hint; the files of the drop are attached', async () => {
    const uploads = controlledUploads();
    start();
    const root = document.querySelector<HTMLElement>('[data-slot="composer"]');
    if (root === null) throw new Error('no composer');
    const notes = new File(['# notes'], 'notes.md', { type: 'text/markdown' });
    fireEvent.drop(root, {
      dataTransfer: {
        types: ['Files'],
        files: [notes],
        items: [
          { kind: 'file', getAsFile: () => null, webkitGetAsEntry: () => ({ isDirectory: true }) },
          { kind: 'file', getAsFile: () => notes, webkitGetAsEntry: () => ({ isDirectory: false }) },
        ],
      },
    });
    await waitFor(() => {
      expect(uploads.map((upload) => upload.name)).toEqual(['notes.md']);
    });
    expect(noticeTexts()).toEqual([{ text: 'composer.attachments.folders' }]);
  });

  it('the shell request attachFiles takes the same way (folders probed); empty or foreign requests pass on', async () => {
    const uploads = controlledUploads();
    const h = start();
    const key = h.key('idle');
    const pdf = sized('Plan.pdf', 'application/pdf', 2048);
    const readable = new File(['all:'], 'Makefile', { type: '' });
    expect(requestShell({ kind: 'attachFiles', sessionKey: key, files: [] })).toBe(false);
    expect(requestShell({ kind: 'attachFiles', sessionKey: `${key}-other`, files: [pdf] })).toBe(false);
    let handled = false;
    act(() => {
      handled = requestShell({
        kind: 'attachFiles',
        sessionKey: key,
        files: [pdf, folderFile('src'), readable],
      });
    });
    expect(handled).toBe(true);
    await waitFor(() => {
      expect(uploads.map((upload) => [upload.name, upload.request.type])).toEqual([
        ['Plan.pdf', 'application/pdf'],
        ['Makefile', 'application/octet-stream'],
      ]);
    });
    expect(noticeTexts()).toEqual([{ text: 'composer.attachments.folders' }]);
    expect(document.activeElement).toBe(textbox());
  });
});
