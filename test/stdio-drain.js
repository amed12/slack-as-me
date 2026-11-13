'use strict';
// Exercise the REAL executable with an injected synthetic run(), preserving pipe backpressure.
// No Keychain, real token, network or Slack write is used.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-stdio-'));
try {
  const cli = require.resolve('../lib/cli.js');
  const preload = path.join(temp, 'preload.cjs');
  const body = JSON.stringify([{user:'U_FIXTURE',ts:'1.000001',text:'😀 unicode synthetic '.repeat(30000)}])+'\n';
  const errors = 'synthetic-error '.repeat(18000)+'\n';
  fs.writeFileSync(preload, `require.cache[${JSON.stringify(cli)}]={id:${JSON.stringify(cli)},filename:${JSON.stringify(cli)},loaded:true,exports:{run:async d=>{d.stdout(${JSON.stringify(body)});d.stderr(${JSON.stringify(errors)});return {code:Number(process.env.SLACK_STDIO_TEST_CODE)};}}};`);
  for (const code of [0,5]) {
    const r=spawnSync(process.execPath,['--require',preload,path.resolve(__dirname,'../bin/slack-as-me'),'read-thread'],{encoding:'utf8',maxBuffer:4*1024*1024,env:{...process.env,SLACK_STDIO_TEST_CODE:String(code)}});
    assert.strictEqual(r.status,code);
    assert.strictEqual(Buffer.byteLength(r.stdout),Buffer.byteLength(body),'stdout must drain fully before exit');
    assert.strictEqual(Buffer.byteLength(r.stderr),Buffer.byteLength(errors),'stderr must drain fully before exit');
    assert.deepStrictEqual(JSON.parse(r.stdout),JSON.parse(body));
  }
  console.log('PASS real executable drains large stdout/stderr and preserves exit codes');
} finally {fs.rmSync(temp,{recursive:true,force:true});}
