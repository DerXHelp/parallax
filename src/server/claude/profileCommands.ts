/**
 * Host commands `profile.*` (ADR-101, WP-30 §4.12): the engine routes them here (HostCommandHandler,
 * WP-40 wires it). Results match `commandResultSchemas`; errors are CommandErrors.
 * - profile.get: the full profile (env values only go to the asking window, ADR-100) + fresh issues
 *   + entryCount;
 * - profile.save → {profileId}; profile.delete (PROFILE_NOT_DELETABLE before PROFILE_IN_USE {count});
 *   profile.setDefault; profile.test ("Profil testen": checkProfile, the result lands in the store →
 *   onChange → HostState); profile.validate (issues only, nothing is written).
 */
import type { ProfileId } from '@shared/common';
import { makeError } from '@shared/errors';
import type { Profile } from '@shared/model';
import type { CommandResult, HostCommandName } from '@shared/protocol';
import { CommandError, type HostCommandHandler } from '../sync/ports';
import type { ClaudeIntegration } from './ports';
import type { PersistentProfileStore } from './profileStore';

export const PROFILE_COMMAND_NAMES = [
  'profile.get',
  'profile.save',
  'profile.delete',
  'profile.setDefault',
  'profile.test',
  'profile.validate',
] as const satisfies readonly HostCommandName[];

export interface ProfileCommandDeps {
  store: PersistentProfileStore;
  integration: ClaudeIntegration;
  /** Entries bound to the profile, archived ones included (registry; delete protection). */
  entryCount(profileId: ProfileId): number;
  now(): Date;
}

export function createProfileCommands(deps: ProfileCommandDeps): HostCommandHandler {
  const { store } = deps;
  const requireProfile = (id: ProfileId): Profile => {
    const profile = store.get(id);
    if (profile === undefined) throw new CommandError(makeError('PROFILE_NOT_FOUND', { profileId: id }));
    return profile;
  };

  return {
    names: PROFILE_COMMAND_NAMES,
    handle: async (cmd) => {
      switch (cmd.name) {
        case 'profile.get': {
          const profile = requireProfile(cmd.profileId);
          const result: CommandResult<'profile.get'> = {
            profile,
            issues: store.issuesOf(profile),
            entryCount: deps.entryCount(profile.id),
          };
          return result;
        }
        case 'profile.save': {
          const saved = store.save(cmd.profile, deps.now());
          const result: CommandResult<'profile.save'> = { profileId: saved.id };
          return result;
        }
        case 'profile.delete': {
          const profile = requireProfile(cmd.profileId);
          if (profile.builtin) {
            throw new CommandError(makeError('PROFILE_NOT_DELETABLE', { profileId: profile.id }));
          }
          const count = deps.entryCount(profile.id);
          if (count > 0) throw new CommandError(makeError('PROFILE_IN_USE', { count }));
          store.remove(profile.id);
          const result: CommandResult<'profile.delete'> = {};
          return result;
        }
        case 'profile.setDefault': {
          store.setDefault(cmd.profileId);
          const result: CommandResult<'profile.setDefault'> = {};
          return result;
        }
        case 'profile.test': {
          const profile = requireProfile(cmd.profileId);
          const claude = await deps.integration.checkProfile(profile.id);
          // An integration over another store (tests, fakes) still reports into this one.
          if (deps.integration.profiles !== store) store.setClaudeStatus(profile.id, claude);
          const result: CommandResult<'profile.test'> = { claude };
          return result;
        }
        case 'profile.validate': {
          const result: CommandResult<'profile.validate'> = { issues: store.issuesOf(cmd.profile) };
          return result;
        }
        case 'fs.listDirectory':
          throw new CommandError(makeError('NOT_IMPLEMENTED', { command: cmd.name }));
      }
    },
  };
}
