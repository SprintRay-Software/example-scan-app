import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runFlow } from './flow.js';
import { createReporter } from './reporter.js';

for (const failure of [null, 'upper.stl', 'tooth-8', 'gingiva-upper', 'prepare', 'final']) {
  test(failure ? `${failure} failure cannot report successful completion` : 'Done follows every successful scan and mesh upload', async t => {
    const dir = await mkdtemp(join(tmpdir(), 'scan-final-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    for (const name of ['upper.stl', 'lower.stl', 'tooth.ply', 'gingiva.ply'])
      await writeFile(join(dir, name), name);

    const calls = [];
    const uploaded = new Set();
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      if (url.startsWith('https://s3.test/')) {
        const name = url.slice('https://s3.test/'.length);
        await new Response(init.body).arrayBuffer();
        if (name === failure) return new Response('failed', { status: 500 });
        uploaded.add(name);
        return new Response(null, { status: 204 });
      }
      const body = init.body ? JSON.parse(init.body) : null;
      if (url.endsWith('/device-login-token'))
        return Response.json({ access_token: 'test', refresh_token: 'test', token_type: 'Bearer' });
      if (url.endsWith('/file/upload'))
        return Response.json('https://s3.test/' + body.fileName);
      if (url.endsWith('/scan-job/scan-job/uploaded')) {
        calls.push('uploaded');
        assert.deepEqual([...uploaded].sort(), ['gingiva-lower', 'gingiva-upper', 'lower.stl', 'tooth-8', 'upper.stl']);
        assert.equal(body, null);
        if (failure === 'final') return new Response('failed', { status: 500 });
        return Response.json({ id: 'scan-job', status: 3 });
      }
      assert.ok(url.endsWith('/scan-job/complete'));
      calls.push('complete');
      if (failure === 'prepare') return new Response('failed', { status: 500 });
      assert.equal(uploaded.size, 2);
      assert.equal(body.segmentedTeeth[0].toothNumber, 8);
      return Response.json({
        id: 'scan-job', status: 2,
        segmentedTeethUploadLinks: [{ toothNumber: 8, url: 'https://s3.test/tooth-8' }],
        gingivaUploadLink: { upper: 'https://s3.test/gingiva-upper', lower: 'https://s3.test/gingiva-lower' },
      });
    });

    const payload = { case: { ID: 'scan-job' }, auth: { code: 'once', tokenEndpoint: '/integration/device-login-token' } };
    const phases = [];
    const summary = await runFlow(createReporter({ phase: (...event) => phases.push(event) }), {
      config: { baseUrl: 'https://backend.test', apiKey: 'test', clientId: 'test', clientSecret: 'test' },
      input: { launchUrl: 'openScanPro://' + Buffer.from(JSON.stringify(payload)).toString('base64'), segmentedTeeth: [8] },
      fixturesDir: dir,
    });
    assert.equal(summary.ok, failure === null);
    assert.equal(summary.completed?.status ?? null, failure === null ? 3 : null);
    assert.deepEqual(calls, failure === 'upper.stl' ? [] :
      failure && failure !== 'final' ? ['complete'] : ['complete', 'uploaded']);
    assert.equal(phases.some(([stage, status]) => stage === 'complete' && status === 'done'), failure === null);
  });
}
