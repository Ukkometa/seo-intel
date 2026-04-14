import { createServer } from 'http';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { spawn } from 'child_process';
import { dirname, join, extname } from 'path';
import { fileURLToPath } from 'url';
import { checkForUpdates, getUpdateInfo } from './lib/updater.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3000', 10);
const PROGRESS_FILE = join(__dirname, '.extraction-progress.json');
const REPORTS_DIR = join(__dirname, 'reports');


function buildActionsMarkdown(payload) {
  const grouped = (payload.actions || []).reduce((acc, action) => {
    const area = action.area || 'other';
    if (!acc[area]) acc[area] = [];
    acc[area].push(action);
    return acc;
  }, {});

  const lines = [
    `# SEO Intel Actions — ${payload.project}`,
    '',
    `- Generated: ${payload.generatedAt || new Date().toISOString()}`,
    `- Scope: ${payload.scope || 'all'}`,
    `- Total actions: ${(payload.actions || []).length}`,
    `- Priority mix: critical ${payload.summary?.critical || 0}, high ${payload.summary?.high || 0}, medium ${payload.summary?.medium || 0}, low ${payload.summary?.low || 0}`,
    '',
    '## Summary',
    '',
    `- Critical: ${payload.summary?.critical || 0}`,
    `- High: ${payload.summary?.high || 0}`,
    `- Medium: ${payload.summary?.medium || 0}`,
    `- Low: ${payload.summary?.low || 0}`,
    '',
  ];

  const orderedAreas = ['technical', 'content', 'schema', 'structure', 'other'];
  for (const area of orderedAreas) {
    const items = grouped[area] || [];
    if (!items.length) continue;
    lines.push(`## ${area.charAt(0).toUpperCase() + area.slice(1)}`);
    lines.push('');
    for (const action of items) {
      lines.push(`### ${action.title}`);
      lines.push(`- ID: ${action.id}`);
      lines.push(`- Type: ${action.type}`);
      lines.push(`- Priority: ${action.priority}`);
      lines.push(`- Why: ${action.why}`);
      if (action.evidence?.length) {
        lines.push('- Evidence:');
        for (const item of action.evidence) lines.push(`  - ${item}`);
      }
      if (action.implementationHints?.length) {
        lines.push('- Implementation hints:');
        for (const item of action.implementationHints) lines.push(`  - ${item}`);
      }
      lines.push('');
    }
  }

  if (!(payload.actions || []).length) {
    lines.push('## No actions found');
    lines.push('');
    lines.push('- The current dataset did not surface any qualifying actions for this scope.');
    lines.push('');
  }

  return lines.join('\n');
}

function getExportHistory() {
  if (!existsSync(REPORTS_DIR)) return [];
  return readdirSync(REPORTS_DIR)
    .filter(name => /-actions-.*\.(json|md)$/i.test(name))
    .map(name => {
      const match = name.match(/^(.*?)-actions-(.*)\.(json|md)$/i);
      return {
        name,
        project: match?.[1] || null,
        stamp: match?.[2] || null,
        format: (match?.[3] || '').toLowerCase(),
        url: `/reports/${name}`,
      };
    })
    .sort((a, b) => a.name < b.name ? 1 : -1);
}

// ── MIME types ──
const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.zip': 'application/zip',
};

// ── Read progress with PID liveness check (mirrors cli.js) ──
function readProgress() {
  try {
    if (!existsSync(PROGRESS_FILE)) return null;
    const data = JSON.parse(readFileSync(PROGRESS_FILE, 'utf8'));
    if (data.status === 'running' && data.pid) {
      try { process.kill(data.pid, 0); } catch (e) {
        if (e.code === 'ESRCH') {
          data.status = 'crashed';
          data.crashed_at = data.updated_at;
        }
      }
    }
    return data;
  } catch { return null; }
}

// ── Parse JSON body from request ──
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1e5) reject(new Error('Body too large')); });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}

// ── JSON response helper ──
function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// ── Serve static file ──
function serveFile(res, filePath) {
  if (!existsSync(filePath)) { res.writeHead(404); res.end('Not found'); return; }
  const ext = extname(filePath);
  const mime = MIME[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': mime });
  res.end(readFileSync(filePath));
}

// ── Available project configs ──
function getProjects() {
  const configDir = join(__dirname, 'config');
  if (!existsSync(configDir)) return [];
  return readdirSync(configDir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try {
        const cfg = JSON.parse(readFileSync(join(configDir, f), 'utf8'));
        return { project: cfg.project, domain: cfg.target?.domain };
      } catch { return null; }
    })
    .filter(Boolean);
}

// ── Request handler ──
async function handleRequest(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  // ─── Setup wizard routes ───
  if (path.startsWith('/setup') || path.startsWith('/api/setup/')) {
    try {
      const { handleSetupRequest } = await import('./setup/web-routes.js');
      if (handleSetupRequest(req, res, url)) return;
    } catch (err) {
      console.error('Setup route error:', err);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Setup wizard error: ' + err.message);
      return;
    }
  }

  // ─── Dashboard: auto-generate and serve ───
  if (req.method === 'GET' && path === '/') {
    // Debug: ?tier=free simulates free tier dashboard
    const forceFree = url.searchParams.get('tier') === 'free';

    try {
      const configDir = join(__dirname, 'config');
      const configFiles = existsSync(configDir)
        ? readdirSync(configDir).filter(f => f.endsWith('.json') && f !== 'example.json' && !f.startsWith('setup'))
        : [];

      if (!configFiles.length) {
        console.log('[dashboard] No config files found in', configDir);
        res.writeHead(302, { Location: '/setup' });
        res.end();
        return;
      }
      console.log('[dashboard] Found configs:', configFiles.join(', '), forceFree ? '(tier=free)' : '');

      const { getDb } = await import('./db/db.js');
      const db = getDb(join(__dirname, 'seo-intel.db'));

      // Load all configs that have crawl data
      const activeConfigs = [];
      for (const file of configFiles) {
        try {
          const config = JSON.parse(readFileSync(join(configDir, file), 'utf8'));
          // Use config.project (the authoritative slug) with filename as fallback
          const project = config.project || file.replace('.json', '');
          const pageCount = db.prepare('SELECT COUNT(*) as c FROM pages p JOIN domains d ON d.id=p.domain_id WHERE d.project=?').get(project)?.c || 0;
          if (pageCount > 0) activeConfigs.push({ ...config, project });
        } catch (err) {
          console.error(`[dashboard] Skipping malformed config ${file}:`, err.message);
        }
      }

      if (!activeConfigs.length) {
        // Projects configured but no crawl data yet — send to wizard
        console.log('[dashboard] No active configs with crawl data');
        res.writeHead(302, { Location: '/setup' });
        res.end();
        return;
      }
      console.log('[dashboard] Active projects:', activeConfigs.map(c => c.project).join(', '));

      if (forceFree) {
        process.env.SEO_INTEL_FORCE_FREE = '1';
        const { _resetLicenseCache } = await import('./lib/license.js');
        _resetLicenseCache();
      }

      // Always generate fresh — one dashboard for all projects (1 or many)
      const { generateMultiDashboard } = await import('./reports/generate-html.js');
      const outPath = generateMultiDashboard(db, activeConfigs);

      if (forceFree) {
        delete process.env.SEO_INTEL_FORCE_FREE;
        const { _resetLicenseCache } = await import('./lib/license.js');
        _resetLicenseCache();
      }
      serveFile(res, outPath);
    } catch (err) {
      console.error('[dashboard] Generation error:', err.message);
      // Generation failed — try serving a cached dashboard
      const allDash = join(REPORTS_DIR, 'all-projects-dashboard.html');
      if (existsSync(allDash)) { serveFile(res, allDash); return; }
      const htmlFiles = existsSync(REPORTS_DIR) ? readdirSync(REPORTS_DIR).filter(f => f.endsWith('-dashboard.html')) : [];
      if (htmlFiles.length) { serveFile(res, join(REPORTS_DIR, htmlFiles[0])); return; }
      res.writeHead(302, { Location: '/setup' });
      res.end();
    }
    return;
  }

  if (req.method === 'GET' && path.startsWith('/reports/')) {
    const fileName = path.replace('/reports/', '');
    if (fileName.includes('..') || fileName.includes('/')) { res.writeHead(400); res.end('Bad path'); return; }
    serveFile(res, join(REPORTS_DIR, fileName));
    return;
  }

  // ─── AI Smart Export loader page (standalone popup) ───
  if (req.method === 'GET' && path === '/ai-loader') {
    const exportUrl = url.searchParams.get('url') || '';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI Smart Export</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&family=Syne:wght@600;700;800&display=swap" rel="stylesheet">
<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"><\/script>
<style>
*{margin:0;padding:0;box-sizing:border-box;}
body,html{width:100%;height:100%;background:#0a0a0a;font-family:'Inter',sans-serif;color:#e0e0e0;overflow:hidden;}
#swarmBg{position:fixed;inset:0;z-index:0;}
.card{position:relative;z-index:2;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;padding:32px;}
.inner{background:rgba(18,18,18,0.75);backdrop-filter:blur(16px);border:1px solid rgba(212,175,55,0.15);border-radius:20px;padding:40px 48px 32px;text-align:center;box-shadow:0 0 80px rgba(212,175,55,0.06),0 32px 64px rgba(0,0,0,0.5);max-width:440px;width:100%;}
h1{font-family:'Syne',sans-serif;font-size:1.3rem;color:#d4af37;margin-bottom:4px;letter-spacing:-0.02em;}
h1 i{margin-right:8px;}
.sub{font-size:0.72rem;color:#777;margin-bottom:28px;}
.status{font-size:0.76rem;color:#aaa;margin-bottom:18px;min-height:1.4em;transition:all 0.3s;}
.status i{color:#d4af37;margin-right:8px;}
.track{width:100%;height:5px;background:rgba(255,255,255,0.05);border-radius:5px;overflow:hidden;margin-bottom:6px;}
.bar{height:100%;width:0%;border-radius:5px;background:linear-gradient(90deg,#d4af37,#f5c842,#d4af37);background-size:200% 100%;animation:shimmer 1.5s ease infinite;transition:width 0.6s cubic-bezier(0.4,0,0.2,1);}
@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
.pct{font-size:0.62rem;color:#555;font-family:'SF Mono',ui-monospace,monospace;text-align:right;margin-bottom:20px;}
.cancel{font-size:0.64rem;color:#666;background:none;border:1px solid #333;padding:5px 18px;border-radius:8px;cursor:pointer;transition:all 0.2s;}
.cancel:hover{color:#ccc;border-color:#666;}
.done-msg{display:none;margin-top:16px;font-size:0.7rem;color:#50c878;}
.done-msg i{margin-right:6px;}
</style></head><body>
<div id="swarmBg"></div>
<div class="card"><div class="inner">
  <h1><i class="fa-solid fa-wand-magic-sparkles"></i> AI Smart Export</h1>
  <p class="sub">Enriching your report with AI intelligence</p>
  <div class="status" id="status"><i class="fa-solid fa-brain fa-beat-fade"></i> Initializing...</div>
  <div class="track"><div class="bar" id="bar"></div></div>
  <div class="pct" id="pct">0%</div>
  <button class="cancel" id="cancelBtn">Cancel</button>
  <div class="done-msg" id="doneMsg"><i class="fa-solid fa-circle-check"></i> Export complete — file downloaded</div>
</div></div>
<script>
(function(){
  // ── Swarm ──
  var el=document.getElementById('swarmBg'),N=350;
  var sc=new THREE.Scene();sc.fog=new THREE.FogExp2(0x0a0a0a,0.003);
  var cam=new THREE.PerspectiveCamera(60,innerWidth/innerHeight,1,800);cam.position.set(0,0,220);
  var r=new THREE.WebGLRenderer({antialias:true,alpha:true});r.setSize(innerWidth,innerHeight);r.setPixelRatio(Math.min(devicePixelRatio,1.5));r.setClearColor(0x0a0a0a,1);el.appendChild(r.domElement);
  var cv=document.createElement('canvas');cv.width=cv.height=64;var cx=cv.getContext('2d'),g=cx.createRadialGradient(32,32,0,32,32,32);
  g.addColorStop(0,'rgba(255,255,255,1)');g.addColorStop(0.3,'rgba(212,175,55,0.9)');g.addColorStop(1,'rgba(212,175,55,0)');cx.fillStyle=g;cx.fillRect(0,0,64,64);
  var tex=new THREE.CanvasTexture(cv);
  var pos=new Float32Array(N*3),col=new Float32Array(N*3),sz=new Float32Array(N);
  for(var i=0;i<N;i++){var t=i/N,ao=(i%4)*(Math.PI/2),rd=Math.pow(t,0.5)*120,a=t*Math.PI*6+ao;
    pos[i*3]=Math.cos(a)*rd;pos[i*3+1]=(Math.random()-0.5)*14*(1-t);pos[i*3+2]=Math.sin(a)*rd;
    var ig=Math.random()>0.65;col[i*3]=ig?0.83:0.35;col[i*3+1]=ig?0.69:0.48;col[i*3+2]=ig?0.22:0.93;sz[i]=ig?3.2:1.6;}
  var geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.BufferAttribute(pos,3));
  geo.setAttribute('color',new THREE.BufferAttribute(col,3));geo.setAttribute('size',new THREE.BufferAttribute(sz,1));
  var vs='attribute float size;attribute vec3 color;varying vec3 vColor;void main(){vColor=color;vec4 mv=modelViewMatrix*vec4(position,1.0);gl_PointSize=size*2.2*(220.0/-mv.z);gl_Position=projectionMatrix*mv;}';
  var fs='uniform sampler2D pointTexture;varying vec3 vColor;void main(){vec4 tc=texture2D(pointTexture,gl_PointCoord);if(tc.a<0.1)discard;gl_FragColor=vec4(vColor*1.8,1.0)*tc;}';
  var mat=new THREE.ShaderMaterial({uniforms:{pointTexture:{value:tex}},vertexShader:vs,fragmentShader:fs,blending:THREE.AdditiveBlending,depthTest:false,transparent:true});
  sc.add(new THREE.Points(geo,mat));
  var maxD=30*30,lp=new Float32Array(N*36),lg=new THREE.BufferGeometry();lg.setAttribute('position',new THREE.BufferAttribute(lp,3));
  sc.add(new THREE.LineSegments(lg,new THREE.LineBasicMaterial({color:0xd4af37,transparent:true,opacity:0.07,blending:THREE.AdditiveBlending})));
  var vi=0,cnt=0;for(var i=0;i<N&&cnt<N*5;i++){for(var j=i+1;j<N&&cnt<N*5;j++){var dx=pos[i*3]-pos[j*3],dy=pos[i*3+1]-pos[j*3+1],dz=pos[i*3+2]-pos[j*3+2];if(dx*dx+dy*dy+dz*dz<maxD){lp[vi++]=pos[i*3];lp[vi++]=pos[i*3+1];lp[vi++]=pos[i*3+2];lp[vi++]=pos[j*3];lp[vi++]=pos[j*3+1];lp[vi++]=pos[j*3+2];cnt++;}}}
  lg.setDrawRange(0,cnt*2);lg.attributes.position.needsUpdate=true;
  (function anim(){requestAnimationFrame(anim);sc.rotation.y+=0.0025;sc.rotation.x+=0.0008;r.render(sc,cam)})();
  window.addEventListener('resize',function(){cam.aspect=innerWidth/innerHeight;cam.updateProjectionMatrix();r.setSize(innerWidth,innerHeight);});

  // ── Progress ──
  var STEPS=[
    {at:0,icon:'fa-brain fa-beat-fade',text:'Analyzing report structure...'},
    {at:12,icon:'fa-table-cells fa-fade',text:'Filling empty table cells...'},
    {at:28,icon:'fa-diagram-project fa-beat-fade',text:'Mapping keyword clusters...'},
    {at:45,icon:'fa-magnifying-glass-chart fa-fade',text:'Cross-referencing competitors...'},
    {at:58,icon:'fa-ranking-star fa-beat-fade',text:'Scoring priorities...'},
    {at:72,icon:'fa-list-check fa-fade',text:'Building action plan...'},
    {at:88,icon:'fa-file-export fa-fade',text:'Finalizing export...'}
  ];
  var barEl=document.getElementById('bar'),pctEl=document.getElementById('pct'),statusEl=document.getElementById('status');
  var cur=0,timer=null;
  function ease(s,e,d){var st=Date.now();clearInterval(timer);timer=setInterval(function(){var t=Math.min((Date.now()-st)/d,1),v=s+(e-s)*(1-Math.pow(1-t,3));cur=v;barEl.style.width=v+'%';pctEl.textContent=Math.round(v)+'%';var step=STEPS[0];for(var i=STEPS.length-1;i>=0;i--){if(v>=STEPS[i].at){step=STEPS[i];break;}}statusEl.innerHTML='<i class="fa-solid '+step.icon+'"></i> '+step.text;if(t>=1)clearInterval(timer);},50);}
  ease(0,22,7000);setTimeout(function(){ease(22,48,12000)},7000);setTimeout(function(){ease(48,72,14000)},19000);setTimeout(function(){ease(72,92,20000)},33000);

  // ── Fetch ──
  var exportUrl=${JSON.stringify(exportUrl)};
  var aborted=false;
  var ctrl=new AbortController();
  document.getElementById('cancelBtn').onclick=function(){aborted=true;ctrl.abort();window.close();};
  fetch(exportUrl,{signal:ctrl.signal}).then(function(resp){
    if(!resp.ok)throw new Error('HTTP '+resp.status);
    var cd=resp.headers.get('content-disposition')||'';var m=cd.match(/filename="?([^"]+)"?/);
    var fn=m?m[1]:'export.md';
    return resp.blob().then(function(b){return{blob:b,fn:fn}});
  }).then(function(res){
    clearInterval(timer);cur=100;barEl.style.width='100%';pctEl.textContent='100%';
    statusEl.innerHTML='<i class="fa-solid fa-circle-check" style="color:#50c878"></i> Export complete!';
    document.getElementById('doneMsg').style.display='block';
    document.getElementById('cancelBtn').textContent='Close';
    document.getElementById('cancelBtn').onclick=function(){window.close();};
    var a=document.createElement('a');a.href=URL.createObjectURL(res.blob);a.download=res.fn;a.click();URL.revokeObjectURL(a.href);
  }).catch(function(err){
    if(aborted)return;
    clearInterval(timer);
    statusEl.innerHTML='<i class="fa-solid fa-triangle-exclamation" style="color:#ff6b6b"></i> '+err.message;
    document.getElementById('cancelBtn').textContent='Close';
    document.getElementById('cancelBtn').onclick=function(){window.close();};
  });
})();
<\/script></body></html>`);
    return;
  }

  // ─── API: Get progress ───
  if (req.method === 'GET' && path === '/api/progress') {
    const progress = readProgress();
    json(res, 200, progress || { status: 'idle' });
    return;
  }

  // ─── API: Get projects ───
  if (req.method === 'GET' && path === '/api/projects') {
    json(res, 200, getProjects());
    return;
  }

  // ─── API: Crawl ───
  if (req.method === 'POST' && path === '/api/crawl') {
    try {
      const body = await readBody(req);
      const { project, stealth } = body;
      if (!project) { json(res, 400, { error: 'Missing project' }); return; }

      // Conflict guard
      const progress = readProgress();
      if (progress?.status === 'running') {
        json(res, 409, { error: 'Job already running', progress });
        return;
      }

      const args = ['cli.js', 'crawl', project];
      if (stealth) args.push('--stealth');

      const child = spawn(process.execPath, args, {
        cwd: __dirname,
        detached: true,
        stdio: 'ignore',
      });
      child.unref();

      json(res, 202, { started: true, pid: child.pid, command: 'crawl', project });
    } catch (e) {
      json(res, 500, { error: e.message });
    }
    return;
  }

  // ─── API: Extract ───
  if (req.method === 'POST' && path === '/api/extract') {
    try {
      const body = await readBody(req);
      const { project } = body;
      if (!project) { json(res, 400, { error: 'Missing project' }); return; }

      // Conflict guard
      const progress = readProgress();
      if (progress?.status === 'running') {
        json(res, 409, { error: 'Job already running', progress });
        return;
      }

      const args = ['cli.js', 'extract', project];

      const child = spawn(process.execPath, args, {
        cwd: __dirname,
        detached: true,
        stdio: 'ignore',
      });
      child.unref();

      json(res, 202, { started: true, pid: child.pid, command: 'extract', project });
    } catch (e) {
      json(res, 500, { error: e.message });
    }
    return;
  }


  // ─── API: Stop running job ───
  // ─── API: Update check ───
  if (req.method === 'GET' && path === '/api/update-check') {
    try {
      const info = await getUpdateInfo();
      json(res, 200, info);
    } catch (e) {
      json(res, 200, { hasUpdate: false, error: e.message });
    }
    return;
  }

  if (req.method === 'POST' && path === '/api/stop') {
    try {
      const progress = readProgress();
      if (!progress || !progress.pid) {
        json(res, 404, { error: 'No running job to stop' });
        return;
      }

      // Check if process is actually alive
      let isAlive = false;
      try { process.kill(progress.pid, 0); isAlive = true; } catch { isAlive = false; }

      if (isAlive) {
        try {
          // Graceful: SIGTERM lets the CLI close browsers / write progress
          process.kill(progress.pid, 'SIGTERM');
          // Escalate: SIGKILL after 5s if still alive (stealth browser cleanup needs time)
          setTimeout(() => {
            try { process.kill(progress.pid, 0); } catch { return; } // already dead
            try { process.kill(progress.pid, 'SIGKILL'); } catch {}
          }, 5000);
        } catch (e) {
          if (e.code !== 'ESRCH') throw e;
        }
      }

      // Update progress file — clears both running and crashed states
      try {
        writeFileSync(PROGRESS_FILE, JSON.stringify({
          ...progress,
          status: isAlive ? 'stopped' : 'crashed_cleared',
          stopped_at: Date.now(),
          updated_at: Date.now(),
        }, null, 2));
      } catch { /* best-effort */ }
      json(res, 200, { stopped: true, pid: progress.pid, command: progress.command, wasAlive: isAlive });
    } catch (e) {
      json(res, 500, { error: e.message });
    }
    return;
  }

  // ─── API: Restart — kill running jobs + restart server ───
  if (req.method === 'POST' && path === '/api/restart') {
    try {
      // 1. Kill any running job
      const progress = readProgress();
      if (progress?.status === 'running' && progress.pid) {
        try { process.kill(progress.pid, 'SIGTERM'); } catch {}
        try {
          writeFileSync(PROGRESS_FILE, JSON.stringify({
            ...progress, status: 'stopped', stopped_at: Date.now(), updated_at: Date.now(),
          }, null, 2));
        } catch {}
      }
      json(res, 200, { restarting: true });

      // 2. Restart the server process after response is sent
      setTimeout(() => {
        const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
          cwd: __dirname,
          detached: true,
          stdio: 'ignore',
          env: { ...process.env, SEO_INTEL_AUTO_OPEN: '0' },
        });
        child.unref();
        process.exit(0);
      }, 300);
    } catch (e) {
      json(res, 500, { error: e.message });
    }
    return;
  }

  // ─── API: Export actions ───
  if (req.method === 'POST' && path === '/api/export-actions') {
    try {
      const body = await readBody(req);
      const { project } = body;
      const scope = ['technical', 'competitive', 'suggestive', 'all'].includes(body.scope) ? body.scope : 'all';
      if (!project) { json(res, 400, { error: 'Missing project' }); return; }

      const progress = readProgress();
      if (progress?.status === 'running') {
        json(res, 409, { error: 'Job already running', progress });
        return;
      }

      const args = ['cli.js', 'export-actions', project, '--scope', scope, '--format', 'json'];
      const child = spawn(process.execPath, args, {
        cwd: __dirname,
        env: { ...process.env, FORCE_COLOR: '0' },
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', chunk => { stdout += chunk.toString(); });
      child.stderr.on('data', chunk => { stderr += chunk.toString(); });
      child.on('error', err => { json(res, 500, { error: err.message }); });
      child.on('close', code => {
        if (res.writableEnded) return;
        if (code !== 0) {
          json(res, 500, { error: (stderr || stdout || `export-actions exited with code ${code}`).trim() });
          return;
        }

        const jsonStart = stdout.indexOf('{');
        const jsonEnd = stdout.lastIndexOf('}');
        const rawJson = jsonStart >= 0 && jsonEnd >= jsonStart ? stdout.slice(jsonStart, jsonEnd + 1) : stdout.trim();

        try {
          const data = JSON.parse(rawJson);
          const stamp = new Date().toISOString().slice(0, 10);
          const baseName = `${project}-actions-${stamp}`;
          writeFileSync(join(REPORTS_DIR, `${baseName}.json`), JSON.stringify(data, null, 2), 'utf8');
          writeFileSync(join(REPORTS_DIR, `${baseName}.md`), buildActionsMarkdown(data), 'utf8');
          json(res, 200, { success: true, data });
        } catch (err) {
          json(res, 500, {
            error: 'Failed to parse export output',
            details: err.message,
            output: stdout.trim(),
            stderr: stderr.trim(),
          });
        }
      });
    } catch (e) {
      json(res, 500, { error: e.message });
    }
    return;
  }

  // ─── API: Export history ───
  if (req.method === 'GET' && path === '/api/export-history') {
    json(res, 200, { success: true, items: getExportHistory() });
    return;
  }

  // ─── API: License status ───
  if (req.method === 'GET' && path === '/api/license-status') {
    try {
      const { loadLicense, activateLicense } = await import('./lib/license.js');
      let license = loadLicense();
      if (license.needsActivation) {
        license = await activateLicense();
      }
      json(res, 200, {
        tier: license.tier || 'free',
        valid: license.active || false,
        key: license.key ? license.key.slice(0, 7) + '...' + license.key.slice(-4) : null,
        source: license.source || null,
      });
    } catch (err) {
      json(res, 200, { tier: 'free', valid: false, key: null, source: null });
    }
    return;
  }

  // ─── API: Save license key ───
  if (req.method === 'POST' && path === '/api/save-license') {
    try {
      const body = await readBody(req);
      const { key } = body;
      if (!key || typeof key !== 'string') { json(res, 400, { error: 'No key provided' }); return; }

      const envPath = join(__dirname, '.env');
      let envContent = '';
      if (existsSync(envPath)) {
        envContent = readFileSync(envPath, 'utf8');
      }

      const envVar = 'SEO_INTEL_LICENSE';

      // Remove existing license line
      const lines = envContent.split('\n').filter(l =>
        !l.startsWith('SEO_INTEL_LICENSE=')
      );
      lines.push(`${envVar}=${key}`);

      writeFileSync(envPath, lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n', 'utf8');

      // Set in process.env so activation picks it up
      process.env[envVar] = key;

      // Clear cache and re-validate
      const { clearLicenseCache, activateLicense } = await import('./lib/license.js');
      clearLicenseCache();
      const license = await activateLicense();

      json(res, 200, {
        ok: true,
        tier: license.tier || 'free',
        valid: license.active || false,
      });
    } catch (err) {
      json(res, 500, { error: err.message });
    }
    return;
  }

  // ─── API: Update insight status (Intelligence Ledger) ───
  const insightMatch = path.match(/^\/api\/insights\/(\d+)\/status$/);
  if (req.method === 'POST' && insightMatch) {
    try {
      const id = parseInt(insightMatch[1]);
      const body = await readBody(req);
      const status = body.status;
      if (!['active', 'done', 'dismissed'].includes(status)) {
        json(res, 400, { error: 'Invalid status. Use: active, done, dismissed' });
        return;
      }
      const { getDb, updateInsightStatus } = await import('./db/db.js');
      const db = getDb();
      updateInsightStatus(db, id, status);
      json(res, 200, { success: true, id, status });
    } catch (e) {
      json(res, 500, { error: e.message });
    }
    return;
  }

  // ─── API: Analyze (spawn background) ───
  if (req.method === 'POST' && path === '/api/analyze') {
    try {
      const body = await readBody(req);
      const { project } = body;
      if (!project) { json(res, 400, { error: 'Missing project' }); return; }

      const progress = readProgress();
      if (progress?.status === 'running') {
        json(res, 409, { error: 'Job already running', progress });
        return;
      }

      const args = ['cli.js', 'analyze', project];
      const child = spawn(process.execPath, args, {
        cwd: __dirname,
        detached: true,
        stdio: 'ignore',
      });
      child.unref();

      json(res, 202, { started: true, pid: child.pid, command: 'analyze', project });
    } catch (e) {
      json(res, 500, { error: e.message });
    }
    return;
  }

  // ─── API: Universal Export Download ───
  if (req.method === 'GET' && path === '/api/export/download') {
    try {
      const project = url.searchParams.get('project');
      const section = url.searchParams.get('section') || 'all';
      const format = url.searchParams.get('format') || 'json';

      if (!project || !/^[a-z0-9_-]+$/i.test(project)) { json(res, 400, { error: 'Invalid project name' }); return; }

      const { getDb } = await import('./db/db.js');
      const { gatherProjectData } = await import('./reports/generate-html.js');
      const db = getDb(join(__dirname, 'seo-intel.db'));
      const configPath = join(__dirname, 'config', `${project}.json`);
      const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : null;
      if (!config) { json(res, 404, { error: `Project config not found: ${project}` }); return; }

      const dateStr = new Date().toISOString().slice(0, 10);
      const { createZip } = await import('./lib/export-zip.js');

      // ── Gather dashboard data — same source as the HTML dashboard ──
      const dash = gatherProjectData(db, project, config);

      // ── Build unified export from dashboard data ──
      function buildDashboardExport(dash) {
        const a = dash.latestAnalysis || {};
        const sections = {};

        // ── Status: scorecard + crawl ──
        const target = dash.technicalScores?.find(d => d.isTarget);
        if (target) {
          sections.technical = {
            score: target.score,
            h1_coverage: target.h1Pct + '%',
            meta_coverage: target.metaPct + '%',
            schema_coverage: target.schemaPct + '%',
            title_coverage: target.titlePct + '%',
          };
        }

        // ── Site Watch ──
        if (dash.watchData?.events?.length) {
          const critical = dash.watchData.events.filter(e => e.severity === 'error' || e.severity === 'warning');
          if (critical.length) sections.watch_alerts = critical;
          if (dash.watchData.snapshot) {
            sections.watch_summary = {
              health_score: dash.watchData.snapshot.health_score,
              errors: dash.watchData.snapshot.errors_count,
              warnings: dash.watchData.snapshot.warnings_count,
            };
          }
        }

        // ── Fix Now: technical gaps + quick wins ──
        if (a.technical_gaps?.length) sections.technical_gaps = a.technical_gaps;
        if (a.quick_wins?.length) sections.quick_wins = a.quick_wins;

        // ── Content Strategy: keywords, gaps, new pages, positioning ──
        if (a.keyword_gaps?.length) sections.keyword_gaps = a.keyword_gaps;
        if (dash.keywordGaps?.length) sections.top_keyword_gaps = dash.keywordGaps.slice(0, 50);
        if (a.long_tails?.length) sections.long_tails = a.long_tails;
        if (a.new_pages?.length) sections.new_pages = a.new_pages;
        if (a.content_gaps?.length) sections.content_gaps = a.content_gaps;
        if (a.positioning) sections.positioning = a.positioning;

        // ── AI Citability ──
        if (dash.citabilityData?.scores?.length) {
          const own = dash.citabilityData.scores.filter(s => s.role === 'target' || s.role === 'owned');
          const needsWork = own.filter(s => s.score < 60);
          if (needsWork.length) sections.citability_low_scores = needsWork;
          sections.citability_summary = {
            avg_score: own.length ? Math.round(own.reduce((a, s) => a + s.score, 0) / own.length) : null,
            pages_scored: own.length,
            pages_below_60: needsWork.length,
          };
        }

        // ── Reference: internal links, schema types, keyword ideas ──
        if (dash.internalLinks) {
          sections.internal_links = {
            total_links: dash.internalLinks.totalLinks,
            orphan_pages: dash.internalLinks.orphanCount,
            top_pages: dash.internalLinks.topPages,
          };
        }
        if (dash.schemaBreakdown?.length) {
          const tgt = dash.schemaBreakdown.find(d => d.isTarget);
          if (tgt?.types?.length) sections.schema_types = tgt.types;
        }
        if (a.keyword_inventor?.length) sections.keyword_inventor = a.keyword_inventor;

        // ── Crawl Stats ──
        sections.crawl_stats = dash.crawlStats;

        return sections;
      }

      // ── Helpers for deterministic enrichment ──
      function inferLongTailParent(phrase, keywordGaps) {
        // Match long-tail to its most likely parent keyword from keyword gaps
        const lower = phrase.toLowerCase();
        let best = null, bestScore = 0;
        for (const g of (keywordGaps || [])) {
          const kw = (g.keyword || '').toLowerCase();
          if (!kw || kw.length < 3) continue;
          // Score: how many words from the gap keyword appear in the phrase
          const words = kw.split(/\s+/);
          const score = words.filter(w => lower.includes(w)).length / words.length;
          if (score > bestScore && score >= 0.5) { bestScore = score; best = g.keyword; }
        }
        return best;
      }

      function inferLongTailOpportunity(item) {
        const p = (item.phrase || '').toLowerCase();
        const intent = item.intent || '';
        const pageType = item.page_type || '';
        if (p.startsWith('how to ') || p.includes(' tutorial')) return `How-to ${pageType || 'guide'} — ${intent || 'informational'} intent`;
        if (p.includes(' vs ') || p.includes(' comparison')) return `Comparison ${pageType || 'article'} — captures decision-stage traffic`;
        if (p.includes('best ') || p.includes('top ')) return `Listicle / roundup — high commercial intent`;
        if (p.includes('what is ') || p.includes('explained')) return `Explainer ${pageType || 'page'} — top-of-funnel awareness`;
        if (p.includes(' api ') || p.includes(' sdk ')) return `Technical docs ${pageType || 'page'} — developer intent`;
        if (p.includes(' price') || p.includes(' cost') || p.includes(' pricing')) return `Pricing / comparison page — transactional intent`;
        if (intent) return `${pageType || 'Content'} page — ${intent} intent`;
        return pageType ? `${pageType} page` : '';
      }

      function inferPotential(item) {
        const p = (item.priority || '').toLowerCase();
        if (p === 'high' || p === 'critical') return 'High';
        if (p === 'medium') return 'Medium';
        if (p === 'low') return 'Low';
        // Fallback: questions and comparisons tend to be higher value
        const phrase = (item.phrase || '').toLowerCase();
        if (phrase.startsWith('how') || phrase.includes(' vs ') || phrase.includes('best ')) return 'High';
        if (item.type === 'question' || item.type === 'comparison') return 'High';
        if (item.type === 'ai_query') return 'Medium';
        return 'Medium';
      }

      function dashboardToMarkdown(sections, proj) {
        const date = new Date().toISOString().slice(0, 10);
        let md = `# SEO Intel Report — ${proj}\n\n- Date: ${date}\n\n`;

        const s = sections;

        // ── Technical Scorecard ──
        if (s.technical) {
          md += `## Technical Scorecard\n\n`;
          md += `- Overall: **${s.technical.score}/100**\n`;
          md += `- H1: ${s.technical.h1_coverage} | Meta: ${s.technical.meta_coverage} | Schema: ${s.technical.schema_coverage} | Title: ${s.technical.title_coverage}\n\n`;
        }

        // ── Technical Gaps ──
        if (s.technical_gaps?.length) {
          md += `## Technical Gaps (${s.technical_gaps.length})\n\n`;
          md += `> Implement these schema and markup fixes to qualify for rich results. Start with FAQ and HowTo schema — they have the highest SERP visibility impact.\n\n`;
          md += `| Issue | Affected | Fix |\n|-------|----------|-----|\n`;
          for (const g of s.technical_gaps) md += `| ${g.gap || g.issue || ''} | ${g.affected || g.pages || ''} | ${g.recommendation || g.fix || ''} |\n`;
          md += '\n';
        }

        // ── Quick Wins ──
        if (s.quick_wins?.length) {
          const highCount = s.quick_wins.filter(w => w.impact === 'high').length;
          md += `## Quick Wins (${s.quick_wins.length})\n\n`;
          md += `> **${highCount} high-impact items.** Sort by Impact, pick the top 3 "high" items and implement this week. Each fix takes <30 min and directly improves rankings.\n\n`;
          md += `| Page | Issue | Fix | Impact |\n|------|-------|-----|--------|\n`;
          for (const w of s.quick_wins) md += `| ${w.page || ''} | ${w.issue || ''} | ${w.fix || ''} | ${w.impact || ''} |\n`;
          md += '\n';
        }

        // ── Internal Links ──
        if (s.internal_links) {
          md += `## Internal Links\n\n- Total links: ${s.internal_links.total_links}\n- Orphan pages: ${s.internal_links.orphan_pages}\n`;
          if (s.internal_links.top_pages?.length) {
            md += '\n| Page | Depth Score |\n|------|-------------|\n';
            for (const p of s.internal_links.top_pages) md += `| ${p.url || p.label} | ${p.count} |\n`;
          }
          md += '\n';
        }

        // ── Site Watch ──
        if (s.watch_summary) {
          md += `## Site Watch\n\n- Health: **${s.watch_summary.health_score ?? 'N/A'}** | Errors: ${s.watch_summary.errors} | Warnings: ${s.watch_summary.warnings}\n\n`;
        }
        if (s.watch_alerts?.length) {
          md += `### Alerts (${s.watch_alerts.length})\n\n| Type | Severity | URL | Details |\n|------|----------|-----|---------|\n`;
          for (const e of s.watch_alerts) md += `| ${e.event_type} | ${e.severity} | ${e.url || ''} | ${(e.details || '').slice(0, 80)} |\n`;
          md += '\n';
        }

        // ── Keyword Gaps ──
        if (s.keyword_gaps?.length) {
          const highGaps = s.keyword_gaps.filter(g => (g.competitor_coverage || g.competitor_count || 0) >= 4).length;
          md += `## Keyword Gaps (${s.keyword_gaps.length})\n\n`;
          md += `> **${highGaps} high-priority gaps** (competitor coverage >= 4). Focus on gaps that match existing product features — these are "free points" where you have the product but lack the page.\n\n`;
          md += `| Keyword | Your Coverage | Competitor Coverage |\n|---------|--------------|--------------------|\n`;
          for (const g of s.keyword_gaps) md += `| ${g.keyword || ''} | ${g.your_coverage || g.target_count || 'none'} | ${g.competitor_coverage || g.competitor_count || ''} |\n`;
          md += '\n';
        }

        // ── Top Keyword Gaps (fill frequency + gap from competitor_count) ──
        if (s.top_keyword_gaps?.length) {
          md += `## Top Keyword Gaps\n\n`;
          md += `> Keywords your competitors rank for that you don't cover at all. Frequency = how many competitor sites mention it.\n\n`;
          md += `| Keyword | Frequency | Your Count | Gap |\n|---------|-----------|------------|-----|\n`;
          for (const g of s.top_keyword_gaps) {
            const freq = g.total || g.competitor_count || '';
            const target = g.target || 0;
            const gap = freq ? (Number(freq) - Number(target)) || freq : '';
            md += `| ${g.keyword || ''} | ${freq} | ${target} | ${gap} |\n`;
          }
          md += '\n';
        }

        // ── Long-tail Opportunities (fill parent + opportunity) ──
        if (s.long_tails?.length) {
          md += `## Long-tail Opportunities (${s.long_tails.length})\n\n`;
          md += `> Long-tail keywords are lower competition and higher conversion. Each phrase maps to a parent cluster and content type.\n\n`;
          md += `| Phrase | Parent | Opportunity |\n|-------|--------|-------------|\n`;
          for (const l of s.long_tails) {
            const parent = l.parent || l.keyword || inferLongTailParent(l.phrase, s.keyword_gaps) || '';
            const opportunity = l.opportunity || l.rationale || inferLongTailOpportunity(l) || '';
            md += `| ${l.phrase || ''} | ${parent} | ${opportunity} |\n`;
          }
          md += '\n';
        }

        // ── New Pages to Create (fill rationale from 'why' field) ──
        if (s.new_pages?.length) {
          md += `## New Pages to Create (${s.new_pages.length})\n\n`;
          md += `> Each page targets a specific keyword gap. Create these as standalone pages with proper H1, schema, and internal links from existing content.\n\n`;
          md += `| Title | Target Keyword | Rationale |\n|-------|----------------|----------|\n`;
          for (const p of s.new_pages) {
            const rationale = p.rationale || p.why || p.content_angle || '';
            md += `| ${p.title || ''} | ${p.target_keyword || ''} | ${rationale} |\n`;
          }
          md += '\n';
        }

        // ── Content Gaps (fill gap + suggestion from covered_by, why_it_matters, suggested_title) ──
        if (s.content_gaps?.length) {
          md += `## Content Gaps (${s.content_gaps.length})\n\n`;
          md += `> Topics your competitors cover that you don't. Prioritise gaps where multiple competitors have content — that signals proven search demand.\n\n`;
          md += `| Topic | Gap | Suggestion |\n|-------|-----|------------|\n`;
          for (const g of s.content_gaps) {
            const gap = g.gap || (g.covered_by?.length ? `Covered by ${g.covered_by.join(', ')}` : '') || g.why_it_matters || '';
            const suggestion = g.suggestion || g.suggested_title || (g.format ? `Create a ${g.format} covering this topic` : '') || '';
            md += `| ${g.topic || ''} | ${gap} | ${suggestion} |\n`;
          }
          md += '\n';
        }

        // ── Keyword Ideas (fill potential from priority) ──
        if (s.keyword_inventor?.length) {
          md += `## Keyword Ideas (${s.keyword_inventor.length})\n\n`;
          md += `> Clustered keyword suggestions for content planning. High-potential keywords are questions, comparisons, or high-priority phrases matching your product features.\n\n`;
          md += `| Phrase | Cluster | Potential |\n|-------|---------|----------|\n`;
          for (const k of s.keyword_inventor.slice(0, 50)) {
            const potential = k.potential || k.volume || inferPotential(k) || '';
            md += `| ${k.phrase || ''} | ${k.cluster || ''} | ${potential} |\n`;
          }
          if (s.keyword_inventor.length > 50) md += `\n_...and ${s.keyword_inventor.length - 50} more._\n`;
          md += '\n';
        }

        // ── Positioning Strategy ──
        if (s.positioning) {
          md += `## Positioning Strategy\n\n`;
          if (s.positioning.open_angle) md += `**Open angle:** ${s.positioning.open_angle}\n\n`;
          if (s.positioning.target_differentiator) md += `**Differentiator:** ${s.positioning.target_differentiator}\n\n`;
          if (s.positioning.competitor_map) md += `**Competitor map:** ${s.positioning.competitor_map}\n\n`;
        }

        // ── AI Citability ──
        if (s.citability_summary) {
          md += `## AI Citability\n\n- Average: **${s.citability_summary.avg_score ?? 'N/A'}/100** (${s.citability_summary.pages_scored} pages, ${s.citability_summary.pages_below_60} below 60)\n\n`;
        }
        if (s.citability_low_scores?.length) {
          md += `### Pages Needing Improvement\n\n`;
          md += `> Pages scoring below 60 are unlikely to be cited by AI assistants. Focus on adding structured Q&A, entity depth, and clear factual claims.\n\n`;
          md += `| Score | URL | Tier |\n|-------|-----|------|\n`;
          for (const p of s.citability_low_scores) md += `| ${p.score} | ${p.url || ''} | ${p.tier || ''} |\n`;
          md += '\n';
        }

        // ── Schema Types ──
        if (s.schema_types?.length) {
          md += `## Schema Types (own site)\n\n| Type | Count |\n|------|-------|\n`;
          for (const t of s.schema_types) md += `| ${t.type || t.schema_type || ''} | ${t.count || ''} |\n`;
          md += '\n';
        }

        // ── Crawl Info ──
        if (s.crawl_stats) {
          md += `## Crawl Info\n\n- Last crawl: ${s.crawl_stats.lastCrawl || 'N/A'}\n- Extracted pages: ${s.crawl_stats.extractedPages || 0}\n`;
        }

        return md;
      }

      function toCSV(obj) {
        // Flatten sections into CSV-friendly rows
        const rows = [];
        for (const [key, val] of Object.entries(obj)) {
          if (Array.isArray(val)) {
            for (const item of val) {
              rows.push({ section: key, ...item });
            }
          } else if (val && typeof val === 'object') {
            rows.push({ section: key, ...val });
          }
        }
        if (!rows.length) return '';
        const keys = [...new Set(rows.flatMap(r => Object.keys(r)))];
        const escape = (v) => {
          if (v == null) return '';
          const s = String(v);
          return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
        };
        return [keys.join(','), ...rows.map(r => keys.map(k => escape(r[k])).join(','))].join('\n');
      }

      // ── AI Smart Export enrichment ──
      async function aiEnrichMarkdown(md, proj) {
        const prompt = `You are an SEO strategist reviewing a data export report. Your job is to ENRICH this report, NOT rewrite it.

Rules:
- Keep ALL existing data, tables, headers, and instruction blocks exactly as they are
- Fill any empty table cells (marked with empty | | columns) with concise, actionable content
- For empty "Parent" cells in Long-tail Opportunities: infer the parent keyword cluster
- For empty "Opportunity" cells: classify as how-to guide, comparison, tutorial, landing page, etc.
- For empty "Gap" cells in Content Gaps: describe what content is missing
- For empty "Suggestion" cells: give a specific content format and angle
- For empty "Rationale" cells: explain why this page matters for SEO
- For empty "Potential" cells: rate as High/Medium/Low based on keyword type
- After the last section, add a new section "## AI Action Plan" with a numbered list of the top 10 highest-impact actions, ordered by priority
- Keep the same markdown format — tables, headers, blockquotes
- Be concise — table cells should be under 80 chars
- Do NOT add commentary, preamble, or explanation outside the report

Here is the report to enrich:

${md}`;
        return new Promise((resolve) => {
          const child = spawn('gemini', ['-p', '-'], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: process.env,
            timeout: 120000,
          });
          let stdout = '', stderr = '';
          child.stdout.on('data', (d) => { stdout += d.toString(); });
          child.stderr.on('data', (d) => { stderr += d.toString(); });
          child.on('error', (err) => {
            console.warn('[ai-export] Gemini spawn failed:', err.message);
            resolve(md + `\n\n> _AI enrichment unavailable: ${err.message}_\n`);
          });
          child.on('close', (code) => {
            if (code === 0 && stdout.trim()) {
              resolve(stdout);
            } else {
              console.warn('[ai-export] Gemini exited', code, stderr.slice(0, 200));
              resolve(md + `\n\n> _AI enrichment unavailable: gemini exited ${code}_\n`);
            }
          });
          child.stdin.write(prompt);
          child.stdin.end();
        });
      }

      // ── Build and serve ──
      const sections = buildDashboardExport(dash);
      const useAi = url.searchParams.get('ai') === 'true';

      if (format === 'json') {
        const content = JSON.stringify({ project, date: dateStr, ...sections }, null, 2);
        const fileName = `${project}-${dateStr}.json`;
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="${fileName}"` });
        res.end(content);
      } else if (format === 'md') {
        let content = dashboardToMarkdown(sections, project);
        if (useAi) content = await aiEnrichMarkdown(content, project);
        const fileName = `${project}-${useAi ? 'ai-' : ''}${dateStr}.md`;
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="${fileName}"` });
        res.end(content);
      } else if (format === 'csv') {
        const content = toCSV(sections);
        const fileName = `${project}-${dateStr}.csv`;
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${fileName}"` });
        res.end(content || 'No data.');
      } else if (format === 'zip') {
        const entries = [];
        entries.push({ name: `${project}-${dateStr}.json`, content: JSON.stringify({ project, date: dateStr, ...sections }, null, 2) });
        let mdContent = dashboardToMarkdown(sections, project);
        if (useAi) mdContent = await aiEnrichMarkdown(mdContent, project);
        entries.push({ name: `${project}-${useAi ? 'ai-' : ''}${dateStr}.md`, content: mdContent });
        const csv = toCSV(sections);
        if (csv) entries.push({ name: `${project}-${dateStr}.csv`, content: csv });
        const zipBuf = createZip(entries);
        res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${project}-${dateStr}.zip"`, 'Content-Length': zipBuf.length });
        res.end(zipBuf);
      } else {
        json(res, 400, { error: 'Invalid format. Allowed: json, csv, md, zip' });
      }
    } catch (e) {
      console.error('[export/download]', e);
      json(res, 500, { error: e.message });
    }
    return;
  }

  // ─── API: SSE Terminal — stream command output ───
  if (req.method === 'GET' && path === '/api/terminal') {
    const params = url.searchParams;
    const command = params.get('command');
    const project = params.get('project') || '';
    if (project && !/^[a-z0-9_-]+$/i.test(project)) {
      json(res, 400, { error: 'Invalid project name' });
      return;
    }

    // Whitelist allowed commands
    const ALLOWED = ['crawl', 'extract', 'analyze', 'export-actions', 'competitive-actions',
      'suggest-usecases', 'html', 'status', 'brief', 'keywords', 'report', 'guide',
      'schemas', 'headings-audit', 'orphans', 'entities', 'friction', 'shallow', 'decay', 'export', 'templates',
      'aeo', 'blog-draft', 'gap-intel', 'watch', 'scan'];

    if (!command || !ALLOWED.includes(command)) {
      json(res, 400, { error: `Invalid command. Allowed: ${ALLOWED.join(', ')}` });
      return;
    }

    // Build args
    const args = ['cli.js', command];

    // scan takes a domain (not a project slug) — validate and route separately
    if (command === 'scan') {
      const domain = (params.get('domain') || project || '').trim();
      if (!domain || !/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(domain)) {
        json(res, 400, { error: 'scan requires a valid domain (e.g. dgents.ai)' });
        return;
      }
      args.push(domain);
      if (params.get('stealth') === 'true') args.push('--stealth');
    } else {
      if (project && command !== 'status' && command !== 'html') args.push(project);
      if (params.get('stealth') === 'true') args.push('--stealth');
    }
    if (params.get('scope')) args.push('--scope', params.get('scope'));
    if (params.get('format')) args.push('--format', params.get('format'));
    if (params.get('topic')) args.push('--topic', params.get('topic'));
    if (params.get('lang')) args.push('--lang', params.get('lang'));
    if (params.get('model')) args.push('--model', params.get('model'));
    if (params.has('save')) args.push('--save');
    if (params.get('vs')) args.push('--vs', params.get('vs'));
    if (params.get('type')) args.push('--type', params.get('type'));
    if (params.get('limit')) args.push('--limit', params.get('limit'));
    if (params.has('raw')) args.push('--raw');
    // --out is NOT passed from dashboard — write paths are server-controlled only (see auto-save below)

    // Auto-save exports from dashboard to reports/
    const EXPORT_CMDS = ['export-actions', 'suggest-usecases', 'competitive-actions'];
    if (EXPORT_CMDS.includes(command) && project) {
      const scope = params.get('scope') || 'all';
      const ts = new Date().toISOString().slice(0, 10);
      const slug = command === 'suggest-usecases' ? 'suggestions' : scope;
      const outFile = join(__dirname, 'reports', `${project}-${slug}-${ts}.md`);
      args.push('--output', outFile);
      args.push('--format', 'brief');
    }
    // Auto-save AEO audit output
    if (command === 'aeo' && project) {
      const ts = new Date().toISOString().slice(0, 10);
      args.push('--save');
    }

    // SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    const send = (type, data) => {
      res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
    };

    const isLongRunning = ['crawl', 'extract', 'scan'].includes(command);

    send('start', { command, project, args: args.slice(1) });

    const child = spawn(process.execPath, args, {
      cwd: __dirname,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      // Crawl/extract: detach so they survive SSE disconnect
      ...(isLongRunning ? { detached: true } : {}),
    });

    let clientClosed = false;

    child.stdout.on('data', chunk => {
      if (clientClosed) return;
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        if (line) send('stdout', line);
      }
    });

    child.stderr.on('data', chunk => {
      if (clientClosed) return;
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        if (line) send('stderr', line);
      }
    });

    child.on('error', err => {
      if (!clientClosed) { send('error', err.message); res.end(); }
    });

    child.on('close', code => {
      if (!clientClosed) { send('exit', { code }); res.end(); }
    });

    // Client disconnect: kill short commands, let crawl/extract continue
    req.on('close', () => {
      clientClosed = true;
      if (isLongRunning) {
        // Detach — crawl/extract keeps running, progress file tracks it
        child.unref();
        if (child.stdout) child.stdout.destroy();
        if (child.stderr) child.stderr.destroy();
      } else {
        if (!child.killed) child.kill();
      }
    });

    return;
  }

  // ─── Favicon ───
  if (req.method === 'GET' && (path === '/favicon.ico' || path === '/favicon.png')) {
    const faviconPath = join(__dirname, 'seo-intel.png');
    if (existsSync(faviconPath)) {
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=3600',
      });
      res.end(readFileSync(faviconPath));
    } else {
      res.writeHead(204); res.end();
    }
    return;
  }

  // ─── 404 ───
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
}

// ─── Start server ───
const server = createServer((req, res) => {
  handleRequest(req, res).catch(err => {
    console.error('Server error:', err);
    if (!res.headersSent) { res.writeHead(500); res.end('Internal error'); }
  });
});

// Start background update check
checkForUpdates();

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`\n  ⚠️  Port ${PORT} is already in use — opening existing dashboard…\n`);
    const url = `http://localhost:${PORT}`;
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    import('child_process').then(({ exec }) => exec(`${cmd} "${url}"`));
    setTimeout(() => process.exit(0), 500);
  } else {
    throw err;
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  SEO Intel Dashboard Server`);
  console.log(`  http://localhost:${PORT}\n`);
  console.log(`  Endpoints:`);
  console.log(`    GET  /              → Dashboard`);
  console.log(`    GET  /setup         → Setup Wizard`);
  console.log(`    GET  /api/progress  → Live extraction progress`);
  console.log(`    GET  /api/projects  → Available projects`);
  console.log(`    GET  /api/export-history → List saved action exports`);
  console.log(`    POST /api/crawl     → Start crawl { project, stealth? }`);
  console.log(`    POST /api/extract   → Start extract { project, stealth? }`);
  console.log(`    POST /api/export-actions → Run export-actions { project, scope }`);
  console.log(`    GET  /api/terminal  → SSE command streaming\n`);

  // Auto-open browser if requested
  if (process.env.SEO_INTEL_AUTO_OPEN === '1') {
    const url = `http://localhost:${PORT}`;
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    import('child_process').then(({ exec }) => exec(`${cmd} "${url}"`));
  }
});
