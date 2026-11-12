import { describe, expect, it } from 'vitest';
import { LOCAL_HOST_ID, makeSessionKey } from '@shared/common';
import { SAMPLE_IDS, sampleItems, sampleSystemItems, sampleTime } from '@shared/samples';
import { fileActions } from './actions';
import { columnOffset } from './columns';
import { fileToolIndex, toolFilePath } from './file-tools';
import { fileName, parentPath, relativeToRoot } from './paths';

const KEY = makeSessionKey(LOCAL_HOST_ID, SAMPLE_IDS.entry);

describe('files lib/paths', () => {
  it('relativeToRoot keeps the spelling of the path, null outside or for the root itself', () => {
    expect(relativeToRoot('D:\\work\\sample\\src\\Main.ts', 'd:\\WORK\\sample')).toBe('src\\Main.ts');
    expect(relativeToRoot('D:\\work\\sample\\src\\main.ts', 'D:\\work\\sample\\')).toBe('src\\main.ts');
    expect(relativeToRoot('D:\\work\\other\\a.ts', 'D:\\work\\sample')).toBeNull();
    expect(relativeToRoot('D:\\work\\sample', 'D:\\work\\sample')).toBeNull();
    expect(relativeToRoot('D:\\work\\sample\\a.ts', null)).toBeNull();
  });

  it('parentPath and fileName', () => {
    expect(parentPath('D:\\a\\b.txt')).toBe('D:\\a');
    expect(parentPath('D:\\a.txt')).toBe('D:\\');
    expect(parentPath('D:\\')).toBe('');
    expect(fileName('D:\\a\\b.txt')).toBe('b.txt');
    expect(fileName('D:\\')).toBe('D:\\');
  });
});

describe('files lib/columns', () => {
  it('columnOffset counts characters, tabs advance to the next tab stop, past the end = end', () => {
    expect(columnOffset('const a = 1;', 1)).toBe(0);
    expect(columnOffset('const a = 1;', 7)).toBe(6);
    expect(columnOffset('\tx', 2)).toBe(4);
    expect(columnOffset('ab\tx', 4)).toBe(4);
    expect(columnOffset('abcd\tx', 6)).toBe(8);
    expect(columnOffset('abc', 99)).toBe(3);
    expect(columnOffset('abc', 0)).toBe(0);
  });
});

describe('files lib/file-tools', () => {
  it('reads the file path of file tools (Git Bash paths converted, unsafe paths dropped)', () => {
    expect(toolFilePath({ toolName: 'Read', input: { file_path: 'D:\\a.ts' } })).toBe('D:\\a.ts');
    expect(toolFilePath({ toolName: 'Edit', input: { file_path: '/d/work/a.ts' } })).toBe('D:\\work\\a.ts');
    expect(toolFilePath({ toolName: 'NotebookEdit', input: { notebook_path: 'D:\\n.ipynb' } })).toBe(
      'D:\\n.ipynb',
    );
    expect(toolFilePath({ toolName: 'Write', input: { file_path: '\\\\server\\share\\a.ts' } })).toBeNull();
    expect(toolFilePath({ toolName: 'Bash', input: { command: 'dir' } })).toBeNull();
  });

  it('indexes the newest finished write per file; the signature changes with every finished file tool', () => {
    const write = sampleItems.toolCall({
      toolUseId: 'toolu_w',
      toolName: 'Write',
      input: { file_path: 'D:\\a.ts' },
      result: {
        isError: false,
        content: [],
        structured: null,
        structuredTruncated: null,
        at: sampleTime(10),
      },
    });
    const failed = sampleItems.toolCall({
      id: 'x:1',
      toolUseId: 'toolu_f',
      toolName: 'Edit',
      input: { file_path: 'D:\\b.ts' },
      result: { isError: true, content: [], structured: null, structuredTruncated: null, at: sampleTime(11) },
    });
    const running = sampleItems.toolCall({
      id: 'x:2',
      toolUseId: 'toolu_r',
      toolName: 'Edit',
      input: { file_path: 'D:\\a.ts' },
      status: 'running',
      result: null,
    });
    const index = fileToolIndex([write, failed, running]);
    expect([...index.writes.entries()]).toEqual([['d:\\a.ts', Date.parse(sampleTime(10))]]);
    expect(index.signature).toBe('2:toolu_f:0');
    // Cached per array.
    const items = [write];
    expect(fileToolIndex(items)).toBe(fileToolIndex(items));
    // A finished task with an output file counts as well.
    const notification = sampleSystemItems.task_notification();
    const agent = sampleItems.toolCall({ id: 'x:3', toolName: 'Agent', task: notification.task });
    expect(fileToolIndex([write, agent]).signature).toBe('1:toolu_w:1');
  });
});

describe('files lib/actions', () => {
  it('local host: viewer, editor, Explorer, default program (allowed extension), copy', () => {
    expect(fileActions({ sessionKey: KEY, path: 'D:\\a.pdf' }).map((action) => action.id)).toEqual([
      'viewer',
      'editor',
      'explorer',
      'default',
      'copy',
    ]);
    expect(
      fileActions({ sessionKey: KEY, path: 'D:\\a.exe', viewer: false }).map((action) => action.id),
    ).toEqual(['editor', 'explorer', 'copy']);
    expect(
      fileActions({ sessionKey: KEY, path: 'D:\\dir', kind: 'directory' }).map((action) => action.id),
    ).toEqual(['viewer', 'explorer', 'copy']);
  });

  it('remote host: viewer and copy only; unsafe paths: nothing', () => {
    const remote = makeSessionKey('remote-1', SAMPLE_IDS.entry);
    expect(fileActions({ sessionKey: remote, path: 'D:\\a.pdf' }).map((action) => action.id)).toEqual([
      'viewer',
      'copy',
    ]);
    expect(fileActions({ sessionKey: KEY, path: '\\\\server\\share\\a.pdf' })).toEqual([]);
  });
});
