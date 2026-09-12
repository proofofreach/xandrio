import { execFileSync } from 'node:child_process';

export function stagePublicSnapshot({ repository, base, source, excludedPaths }) {
  const options = { cwd: repository, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 };
  const exclusions = excludedPaths.map(value => `:(exclude)${value}`);
  const patch = execFileSync('git', ['diff', '--binary', base, source, '--', '.', ...exclusions], options);
  if (patch) execFileSync('git', ['apply', '--index', '--binary', '-'], { ...options, input: patch });
  const remaining = execFileSync('git', ['diff', '--cached', '--name-only', source, '--', '.', ...exclusions], options);
  if (remaining.trim()) throw new Error('Public snapshot differs from the source revision');
}
