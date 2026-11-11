/**
 * WP-51 – `checkAttachments` / `materializeAttachments` (ADR-103, ADR-146) against a blob store
 * double whose refs declare their size (the limits are checked without big buffers). The engine
 * path (create/sendPrompt, sent text vs. item) is in phase3.integration.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { LIMITS, type BlobId, type EntryId } from '@shared/common';
import type { BlobRef } from '@shared/model';
import { sampleBlobId, sampleBlobRef, sampleId } from '@shared/samples';
import { CommandError, type AttachmentFileStore, type BlobStore } from '../sync/ports';
import {
  FILE_MEDIA_TYPE,
  NO_ATTACHMENTS,
  PDF_MEDIA_TYPE,
  checkAttachments,
  materializeAttachments,
} from './attachments';

const ENTRY: EntryId = sampleId('en', 1);

function blobStore(refs: readonly BlobRef[]): Pick<BlobStore, 'get'> {
  const byId = new Map(refs.map((ref) => [ref.blobId, ref]));
  return {
    get: (blobId: BlobId) => {
      const ref = byId.get(blobId);
      return Promise.resolve(ref === undefined ? null : { ref, data: Uint8Array.from([1, 2, 3]) });
    },
  };
}

const ref = (n: number, mediaType: string, bytes: number, name: string | null = null): BlobRef =>
  sampleBlobRef({ blobId: sampleBlobId(n), mediaType, bytes, name, width: null, height: null });

async function errorOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CommandError) return error.error;
    throw error;
  }
  throw new Error('expected a CommandError');
}

describe('checkAttachments (ADR-146)', () => {
  it('images → image blocks, PDFs → document blocks (list order), files kept for materializing', async () => {
    const png = ref(1, 'image/png', 10);
    const pdf = ref(2, PDF_MEDIA_TYPE, 10);
    const file = ref(3, FILE_MEDIA_TYPE, 10, 'a.zip');
    const checked = await checkAttachments(
      blobStore([png, pdf, file]),
      [{ blobId: pdf.blobId }, { blobId: file.blobId }, { blobId: png.blobId }],
      { files: true },
    );
    expect(checked.refs).toEqual([pdf, file, png]);
    expect(checked.blocks).toEqual([
      { type: 'document', mediaType: PDF_MEDIA_TYPE, base64: 'AQID' },
      { type: 'image', mediaType: 'image/png', base64: 'AQID' },
    ]);
    expect(checked.files).toEqual([file]);
    expect(checked.paths).toEqual([]);
    expect(await checkAttachments(blobStore([]), [], { files: true })).toBe(NO_ATTACHMENTS);
  });

  it('a named PDF carries its file name as the document title; empty names are left out', async () => {
    const named = ref(1, PDF_MEDIA_TYPE, 10, 'Angebot März.pdf');
    const empty = ref(2, PDF_MEDIA_TYPE, 10, '');
    const checked = await checkAttachments(
      blobStore([named, empty]),
      [{ blobId: named.blobId }, { blobId: empty.blobId }],
      { files: true },
    );
    expect(checked.blocks).toEqual([
      { type: 'document', mediaType: PDF_MEDIA_TYPE, base64: 'AQID', title: 'Angebot März.pdf' },
      { type: 'document', mediaType: PDF_MEDIA_TYPE, base64: 'AQID' },
    ]);
  });

  it('limits per kind (declared size): image, PDF, file; at the limit is fine', async () => {
    const atLimit = [
      ref(1, 'image/jpeg', LIMITS.imageBytes),
      ref(2, PDF_MEDIA_TYPE, LIMITS.pdfBytes),
      ref(3, FILE_MEDIA_TYPE, LIMITS.fileAttachmentBytes),
    ];
    await expect(
      checkAttachments(
        blobStore(atLimit),
        atLimit.map((r) => ({ blobId: r.blobId })),
        { files: true },
      ),
    ).resolves.toMatchObject({ refs: atLimit });
    for (const [mediaType, max] of [
      ['image/webp', LIMITS.imageBytes],
      [PDF_MEDIA_TYPE, LIMITS.pdfBytes],
      [FILE_MEDIA_TYPE, LIMITS.fileAttachmentBytes],
    ] as const) {
      const big = ref(9, mediaType, max + 1);
      expect(
        await errorOf(checkAttachments(blobStore([big]), [{ blobId: big.blobId }], { files: true })),
      ).toEqual({
        code: 'PAYLOAD_TOO_LARGE',
        params: { blobId: big.blobId, bytes: max + 1, max },
      });
    }
  });

  it('images and PDFs together ≤ attachmentsTotalBytes; files do not count', async () => {
    const pdfA = ref(1, PDF_MEDIA_TYPE, LIMITS.pdfBytes);
    const pdfB = ref(2, PDF_MEDIA_TYPE, LIMITS.pdfBytes);
    const file = ref(3, FILE_MEDIA_TYPE, LIMITS.fileAttachmentBytes);
    // The bigger of declared size and data length counts (the double's data has 3 bytes).
    const image = ref(4, 'image/gif', 3);
    const store = blobStore([pdfA, pdfB, file, image]);
    // Exactly the total plus a file: fine.
    expect(LIMITS.pdfBytes * 2).toBe(LIMITS.attachmentsTotalBytes);
    await expect(
      checkAttachments(
        store,
        [pdfA, file, pdfB].map((r) => ({ blobId: r.blobId })),
        { files: true },
      ),
    ).resolves.toMatchObject({ files: [file] });
    expect(
      await errorOf(
        checkAttachments(
          store,
          [pdfA, pdfB, image].map((r) => ({ blobId: r.blobId })),
          { files: true },
        ),
      ),
    ).toEqual({
      code: 'PAYLOAD_TOO_LARGE',
      params: { bytes: LIMITS.attachmentsTotalBytes + 3, max: LIMITS.attachmentsTotalBytes },
    });
  });

  it('missing blob → BLOB_NOT_FOUND; other types and files without a store → UNSUPPORTED_MEDIA_TYPE', async () => {
    const text = ref(1, 'text/plain', 3);
    const file = ref(2, FILE_MEDIA_TYPE, 3);
    const store = blobStore([text, file]);
    const missing = sampleBlobId(9);
    expect(await errorOf(checkAttachments(store, [{ blobId: missing }], { files: true }))).toEqual({
      code: 'BLOB_NOT_FOUND',
      params: { blobId: missing },
    });
    expect(await errorOf(checkAttachments(store, [{ blobId: text.blobId }], { files: true }))).toEqual({
      code: 'UNSUPPORTED_MEDIA_TYPE',
      params: { blobId: text.blobId, mediaType: 'text/plain' },
    });
    expect(await errorOf(checkAttachments(store, [{ blobId: file.blobId }], { files: false }))).toEqual({
      code: 'UNSUPPORTED_MEDIA_TYPE',
      params: { blobId: file.blobId, mediaType: FILE_MEDIA_TYPE },
    });
  });
});

describe('materializeAttachments (ADR-146)', () => {
  const calls: { entryId: EntryId; blobId: BlobId; name: string | null }[] = [];
  const store: AttachmentFileStore = {
    dir: (entryId) => Promise.resolve(`C:\\home\\entries\\${entryId}\\attachments`),
    materialize: (entryId, blobId, name) => {
      calls.push({ entryId, blobId, name });
      return Promise.resolve(
        `C:\\home\\entries\\${entryId}\\attachments\\${blobId.slice(0, 16)}\\${name ?? 'x.bin'}`,
      );
    },
  };

  it('copies every file in order and returns the paths; without files nothing is called', async () => {
    const a = ref(1, FILE_MEDIA_TYPE, 1, 'a.csv');
    const b = ref(2, FILE_MEDIA_TYPE, 1, null);
    const checked = await checkAttachments(blobStore([a, b]), [{ blobId: a.blobId }, { blobId: b.blobId }], {
      files: true,
    });
    const done = await materializeAttachments(store, ENTRY, checked);
    expect(calls).toEqual([
      { entryId: ENTRY, blobId: a.blobId, name: 'a.csv' },
      { entryId: ENTRY, blobId: b.blobId, name: null },
    ]);
    expect(done.paths).toEqual([
      `C:\\home\\entries\\${ENTRY}\\attachments\\${a.blobId.slice(0, 16)}\\a.csv`,
      `C:\\home\\entries\\${ENTRY}\\attachments\\${b.blobId.slice(0, 16)}\\x.bin`,
    ]);
    expect(await materializeAttachments(null, ENTRY, NO_ATTACHMENTS)).toBe(NO_ATTACHMENTS);
  });

  it('files without a store → UNSUPPORTED_MEDIA_TYPE (the rule holds even if the check was skipped)', async () => {
    const file = ref(1, FILE_MEDIA_TYPE, 1, 'a.bin');
    const checked = { refs: [file], blocks: [], files: [file], paths: [] };
    expect(await errorOf(materializeAttachments(null, ENTRY, checked))).toEqual({
      code: 'UNSUPPORTED_MEDIA_TYPE',
      params: { blobId: file.blobId, mediaType: FILE_MEDIA_TYPE },
    });
  });
});
