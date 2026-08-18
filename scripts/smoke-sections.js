'use strict';
// Additional dashboard coverage, segregated by domain. Invoked from
// scripts/smoke-test.js after the core auth/CRUD sections so every module gets
// a CRUD round-trip and the review's new behaviors are asserted.
//
// t = { ADMIN, READ_ONLY, req, check, ok, created }

module.exports = async function runSmokeSections(t) {
  const { ADMIN, READ_ONLY, req, check, ok, created } = t;
  const section = (title) => console.log(`\n== ${title} ==`);

  // --- IP monitoring (hosts CRUD) --------------------------------------------
  section('IP hosts CRUD');
  {
    const label = `SMOKE-HOST-${Date.now()}`;
    let id = null;
    await check('IPs: create host -> 200 + visible', async () => {
      const r = await req('POST', '/api/ips/hosts', { token: ADMIN, body: { label, ip: '192.0.2.1', enabled: true, sortOrder: 0 } });
      ok('IPs: create -> 200', r.status === 200, `status ${r.status} ${JSON.stringify(r.data)}`);
      const list = await req('GET', '/api/ips/hosts', { token: ADMIN });
      const h = (list.data || []).find((x) => x.label === label);
      ok('IPs: created appears in list', !!h, JSON.stringify(list.data));
      id = h?.id ?? null;
    });
    await check('IPs: update host -> 200', async () => {
      if (!id) return ok('IPs: update host -> 200', false, 'no id');
      const r = await req('PUT', `/api/ips/hosts/${id}`, { token: ADMIN, body: { label: label + '-UPD' } });
      ok('IPs: update -> 200', r.status === 200, `status ${r.status}`);
    });
    await check('IPs: delete host -> 200', async () => {
      if (!id) return ok('IPs: delete host -> 200', false, 'no id');
      const r = await req('DELETE', `/api/ips/hosts/${id}`, { token: ADMIN });
      ok('IPs: delete -> 200', r.status === 200, `status ${r.status}`);
    });
    await check('IPs: create without label -> 400', async () => {
      const r = await req('POST', '/api/ips/hosts', { token: ADMIN, body: { ip: '192.0.2.2' } });
      ok('IPs: missing label -> 400', r.status === 400, `status ${r.status}`);
    });
  }

  // --- Managed services CRUD ---------------------------------------------------
  section('Services CRUD');
  {
    const name = `SMOKE-SVC-${Date.now()}`;
    let id = null;
    await check('Services: create -> 201 + visible', async () => {
      const r = await req('POST', '/api/services', {
        token: ADMIN,
        body: { name, description: 'smoke', type: 'web', target: 'http://example.test', iconPath: '', enabled: true, sortOrder: 0 },
      });
      ok('Services: create -> 201', r.status === 201 || r.status === 200, `status ${r.status}`);
      const list = await req('GET', '/api/services');
      const s = (list.data || []).find((x) => x.name === name);
      ok('Services: created appears in list', !!s, JSON.stringify(list.data));
      id = s?.id ?? null;
    });
    await check('Services: update -> 200', async () => {
      if (!id) return ok('Services: update -> 200', false, 'no id');
      const r = await req('PUT', `/api/services/${id}`, { token: ADMIN, body: { name: name + '-UPD' } });
      ok('Services: update -> 200', r.status === 200, `status ${r.status}`);
    });
    await check('Services: delete -> 200', async () => {
      if (!id) return ok('Services: delete -> 200', false, 'no id');
      const r = await req('DELETE', `/api/services/${id}`, { token: ADMIN });
      ok('Services: delete -> 200', r.status === 200, `status ${r.status}`);
    });
  }

  // --- Audit logs (public POST) ------------------------------------------------
  section('Audit logs');
  await check('Audit: POST create (public) -> 200', async () => {
    const r = await req('POST', '/api/audit-logs', { body: { eventType: 'smoke', notes: 'smoke test' } });
    ok('Audit: create -> 200 + success', r.status === 200 && r.data?.success === true, `status ${r.status} ${JSON.stringify(r.data)}`);
  });
  await check('Audit: GET by edict -> array', async () => {
    const r = await req('GET', '/api/audit-logs/edict/1');
    ok('Audit: by edict -> 200 + array', r.status === 200 && Array.isArray(r.data), `status ${r.status}`);
  });

  // --- Certifications CRUD ------------------------------------------------------
  section('Certifications');
  {
    let id = null;
    await check('Certs: create -> 200 + id', async () => {
      const r = await req('POST', '/api/certifications', { token: ADMIN, body: { name: 'SMOKE-CERT' } });
      ok('Certs: create -> 200 + id', r.status === 200 && Number.isInteger(r.data?.id), `status ${r.status} ${JSON.stringify(r.data)}`);
      id = r.data?.id ?? null;
    });
    await check('Certs: get -> 200', async () => {
      if (!id) return ok('Certs: get -> 200', false, 'no id');
      const r = await req('GET', `/api/certifications/${id}`, { token: ADMIN });
      ok('Certs: get -> 200', r.status === 200 && r.data?.name === 'SMOKE-CERT', `status ${r.status}`);
    });
    await check('Certs: update -> 200', async () => {
      if (!id) return ok('Certs: update -> 200', false, 'no id');
      const r = await req('PUT', `/api/certifications/${id}`, { token: ADMIN, body: { name: 'SMOKE-CERT-UPD' } });
      ok('Certs: update -> 200', r.status === 200, `status ${r.status}`);
    });
    await check('Certs: delete -> 200', async () => {
      if (!id) return ok('Certs: delete -> 200', false, 'no id');
      const r = await req('DELETE', `/api/certifications/${id}`, { token: ADMIN });
      ok('Certs: delete -> 200', r.status === 200, `status ${r.status}`);
    });
    await check('Certs: create without name -> 400', async () => {
      const r = await req('POST', '/api/certifications', { token: ADMIN, body: {} });
      ok('Certs: missing name -> 400', r.status === 400, `status ${r.status}`);
    });
  }

  // --- Job applications CRUD ----------------------------------------------------
  section('Job applications');
  {
    let id = null;
    await check('Apps: create -> 200 + id', async () => {
      const r = await req('POST', '/api/applications', { token: ADMIN, body: { company: 'SmokeCo', role: 'Dev' } });
      ok('Apps: create -> 200 + id', r.status === 200 && Number.isInteger(r.data?.id), `status ${r.status} ${JSON.stringify(r.data)}`);
      id = r.data?.id ?? null;
    });
    await check('Apps: get -> 200', async () => {
      if (!id) return ok('Apps: get -> 200', false, 'no id');
      const r = await req('GET', `/api/applications/${id}`, { token: ADMIN });
      ok('Apps: get -> 200', r.status === 200 && r.data?.company === 'SmokeCo', `status ${r.status}`);
    });
    await check('Apps: update -> 200', async () => {
      if (!id) return ok('Apps: update -> 200', false, 'no id');
      const r = await req('PUT', `/api/applications/${id}`, { token: ADMIN, body: { company: 'SmokeCo-UPD' } });
      ok('Apps: update -> 200', r.status === 200, `status ${r.status}`);
    });
    await check('Apps: delete -> 200', async () => {
      if (!id) return ok('Apps: delete -> 200', false, 'no id');
      const r = await req('DELETE', `/api/applications/${id}`, { token: ADMIN });
      ok('Apps: delete -> 200', r.status === 200, `status ${r.status}`);
    });
    await check('Apps: create without company -> 400', async () => {
      const r = await req('POST', '/api/applications', { token: ADMIN, body: { role: 'Dev' } });
      ok('Apps: missing company -> 400', r.status === 400, `status ${r.status}`);
    });
  }

  // --- Career files (list + no-file guard) --------------------------------------
  section('Career files');
  await check('Career: list -> 200 + array', async () => {
    const r = await req('GET', '/api/career-files', { token: ADMIN });
    ok('Career: list -> 200 + array', r.status === 200 && Array.isArray(r.data), `status ${r.status}`);
  });
  await check('Career: POST without file -> 400', async () => {
    const r = await req('POST', '/api/career-files', { token: ADMIN, body: {} });
    ok('Career: no file -> 400', r.status === 400, `status ${r.status}`);
  });

  // --- Policy modules -------------------------------------------------------------
  section('Policy modules');
  {
    const r = await req('POST', '/api/edicts', { token: ADMIN, body: { name: `SMOKE-MOD-${Date.now()}`, plannedStart: new Date().toISOString(), plannedEnd: null, priority: 1, state: 1, info: 'smoke' } });
    const edictId = r.data?.id ?? null;
    if (!edictId) {
      ok('Policy modules: temp edict', false, 'no id');
    } else {
      created.edicts.push(edictId);
      await check('Modules: attach jobs -> 200', async () => {
        const rr = await req('POST', `/api/edicts/${edictId}/modules`, { token: ADMIN, body: { moduleType: 'jobs' } });
        ok('Modules: attach -> 200 + success', rr.status === 200 && rr.data?.success === true, `status ${rr.status} ${JSON.stringify(rr.data)}`);
      });
      await check('Modules: list contains jobs', async () => {
        const rr = await req('GET', `/api/edicts/${edictId}/modules`);
        ok('Modules: list includes jobs', Array.isArray(rr.data) && rr.data.some((m) => m.moduleType === 'jobs'), JSON.stringify(rr.data));
      });
      await check('Modules: detach jobs -> 200', async () => {
        const rr = await req('DELETE', `/api/edicts/${edictId}/modules/jobs`, { token: ADMIN });
        ok('Modules: detach -> 200 + success', rr.status === 200 && rr.data?.success === true, `status ${rr.status} ${JSON.stringify(rr.data)}`);
      });
      await check('Modules: invalid type -> 400', async () => {
        const rr = await req('POST', `/api/edicts/${edictId}/modules`, { token: ADMIN, body: { moduleType: 'bogus' } });
        ok('Modules: invalid type -> 400', rr.status === 400, `status ${rr.status}`);
      });
      await req('DELETE', `/api/edicts/${edictId}`, { token: ADMIN }).catch(() => {});
      created.edicts = created.edicts.filter((id) => id !== edictId);
    }
  }

  // --- DB inspection endpoints (admin gate) ----------------------------------------
  section('DB inspection endpoints');
  await check('DB: tables with admin -> 200', async () => {
    const r = await req('GET', '/api/db/tables', { token: ADMIN });
    ok('DB: tables -> 200 + array', r.status === 200 && Array.isArray(r.data), `status ${r.status}`);
  });
  await check('DB: rows with admin -> 200', async () => {
    const r = await req('GET', '/api/db/Edicts', { token: ADMIN });
    ok('DB: Edicts rows -> 200 + array', r.status === 200 && Array.isArray(r.data), `status ${r.status}`);
  });
  await check('DB: tables with read-only -> 403', async () => {
    const r = await req('GET', '/api/db/tables', { token: READ_ONLY });
    ok('DB: read-only -> 403', r.status === 403, `status ${r.status}`);
  });

  // --- Pricing ------------------------------------------------------------------------
  section('Pricing');
  await check('Pricing: GET -> 200', async () => {
    const r = await req('GET', '/api/pricing');
    ok('Pricing: 200 + window + stats', r.status === 200 && typeof r.data?.window === 'string' && r.data.stats, `status ${r.status} ${JSON.stringify(r.data)}`);
  });

  // --- Pagination ------------------------------------------------------------------------
  section('Pagination');
  await check('Edicts: limit=2 -> <=2 rows', async () => {
    const r = await req('GET', '/api/edicts?limit=2');
    ok('Edicts: limit -> <=2', r.status === 200 && Array.isArray(r.data) && r.data.length <= 2, `len ${r.data?.length}`);
  });
  await check('Tasks: limit=2 -> <=2 rows', async () => {
    const r = await req('GET', '/api/tasks?limit=2');
    ok('Tasks: limit -> <=2', r.status === 200 && Array.isArray(r.data) && r.data.length <= 2, `len ${r.data?.length}`);
  });
  await check('Resources: limit=2 -> <=2 rows', async () => {
    const r = await req('GET', '/api/resources?limit=2');
    ok('Resources: limit -> <=2', r.status === 200 && Array.isArray(r.data) && r.data.length <= 2, `len ${r.data?.length}`);
  });

  // --- Users UAC: presence + role CRUD ---------------------------------------------
  section('Users UAC (presence + roles)');
  await check('Users: online -> 200 + array', async () => {
    const r = await req('GET', '/api/users/online', { token: ADMIN });
    ok('Users: online -> 200', r.status === 200 && Array.isArray(r.data?.online), `status ${r.status} ${JSON.stringify(r.data)}`);
  });
  await check('Users: sessions -> 200 + array', async () => {
    const r = await req('GET', '/api/users/sessions', { token: ADMIN });
    ok('Users: sessions -> 200', r.status === 200 && Array.isArray(r.data?.sessions), `status ${r.status}`);
  });
  await check('Users: heartbeat invalid -> 400', async () => {
    const r = await req('POST', '/api/users/heartbeat', { token: ADMIN, body: { sessionId: 'abc' } });
    ok('Users: heartbeat invalid -> 400', r.status === 400, `status ${r.status}`);
  });
  {
    const roleName = `SMOKE-ROLE-${Date.now()}`;
    let roleId = null;
    await check('Roles: create -> 201 + id', async () => {
      const r = await req('POST', '/api/users/roles', { token: ADMIN, body: { name: roleName, description: 'smoke' } });
      ok('Roles: create -> 201 + id', r.status === 201 && Number.isInteger(r.data?.id), `status ${r.status} ${JSON.stringify(r.data)}`);
      roleId = r.data?.id ?? null;
    });
    await check('Roles: update -> 200', async () => {
      if (!roleId) return ok('Roles: update -> 200', false, 'no id');
      const r = await req('PUT', `/api/users/roles/${roleId}`, { token: ADMIN, body: { name: roleName + '-UPD' } });
      ok('Roles: update -> 200', r.status === 200, `status ${r.status}`);
    });
    await check('Roles: delete -> 200', async () => {
      if (!roleId) return ok('Roles: delete -> 200', false, 'no id');
      const r = await req('DELETE', `/api/users/roles/${roleId}`, { token: ADMIN });
      ok('Roles: delete -> 200', r.status === 200, `status ${r.status}`);
    });
  }

  // --- Rate limiting (login) — run LAST: locks this test instance's IP for 60s ---
  section('Rate limiting (login)');
  await check('Login: returns 429 after a burst', async () => {
    let saw429 = false;
    for (let i = 0; i < 25; i++) {
      const r = await req('POST', '/api/users/login', { body: { username: 'oswald_admin', password: 'wrong' } });
      if (r.status === 429) { saw429 = true; break; }
    }
    ok('Login: 429 after burst', saw429, 'no 429 seen in 25 attempts');
  });
};
