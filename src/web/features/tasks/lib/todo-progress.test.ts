import { describe, expect, it } from 'vitest';
import { sampleTodoList } from '@shared/samples';
import { todoProgress } from './todo-progress';

describe('todoProgress', () => {
  it('done/total, the active form, open while not all are done', () => {
    expect(todoProgress(null)).toEqual({ done: 0, total: 0, active: null, open: false });
    expect(todoProgress(sampleTodoList())).toEqual({
      done: 1,
      total: 3,
      active: 'Writing the tests',
      open: true,
    });
    const allDone = sampleTodoList({
      items: sampleTodoList().items.map((item) => ({ ...item, status: 'completed' as const })),
    });
    expect(todoProgress(allDone).open).toBe(false);
    const noActiveForm = sampleTodoList({
      items: [{ id: '0', content: 'Write it', status: 'in_progress', activeForm: null }],
    });
    expect(todoProgress(noActiveForm).active).toBe('Write it');
    const emptyActiveForm = sampleTodoList({
      items: [{ id: '0', content: 'Write it', status: 'in_progress', activeForm: '' }],
    });
    expect(todoProgress(emptyActiveForm).active).toBe('Write it');
  });
});
