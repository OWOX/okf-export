// backend.ts — okf-export (v2). Named async fns; the host bundles + sandboxes this file.
// `ctx` is the capability surface minus `ui`, plus ctx.log and ctx.settings. No ambient
// fetch/fs/process/env — every privileged action goes through a brokered ctx.* call.
//
// NOTE: the frontend→backend `backend.call()` bridge isn't wired yet (AGENTS.md §6). The
// interactive UI runs entirely in the frontend (ui/App.tsx) via the live SDK. This function
// exists for the host SCHEDULER (cron) path — a headless "export all reporting marts to GitHub".
// It shares the pure render code with the UI via okf-core.
import { listMarts, buildBundle } from './okf-core';

export async function exportMarts(input: { repo?: string; folder?: string } = {}, ctx: any) {
  const now = new Date().toISOString();
  ctx.log('listing data marts');
  const stubs = (await listMarts(ctx.owox)).filter((m: any) => m.availableForReporting);
  const { files, metas } = await buildBundle(ctx.owox, stubs, now);

  if (!input.repo) throw new Error('A GitHub repo (owner/repo) is required for the scheduled export.');
  const prefix = input.folder ? input.folder.replace(/\/+$/, '') + '/' : 'okf/';
  const g = ctx.git.repo(input.repo);
  for (const [name, content] of Object.entries(files)) await g.putFile(`${prefix}${name}`, content);

  ctx.log(`exported ${metas.length} mart(s) → ${input.repo}`);
  return { ok: true, count: metas.length, repo: input.repo };
}
