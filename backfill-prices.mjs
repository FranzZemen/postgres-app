import {ExecutionContext} from '@franzzemen/execution-context';
import {LoggerApi} from '@franzzemen/logger';
import {loadSecretsExecutionContext} from '@franzzemen/execution-context-secrets-loader';
import {loadPostgresConfig} from './out/project/config-loader/index.js';
import {createPool} from './out/project/pool/index.js';
process.env['BROKENSTOCK_DB']='prod_blue';
await loadSecretsExecutionContext({bootstrap:{awsContext:{secretsManager:{currentSecretSetName:'production',secretSetNames:['production']},environment:'lambda'},profile:'secrets-manager-admin'},overrides:{'aws':{environment:'lambda',lambda:{timeoutSeconds:10}},'execution-context':{name:'backfill'},'log-config':{modules:{modulesToLoad:['cloudWatchLoggerFactory']}}}});
const ec=new ExecutionContext(); await LoggerApi.load(ec);
const ACTOR='00000000-0000-0000-0000-000000000000.user';
const DATES=['2026-06-10','2026-06-11','2026-06-12','2026-06-15','2026-06-16','2026-06-17','2026-06-18'];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function runFeed(feed,date){
  const pool=createPool(ec,loadPostgresConfig(ec,'rds-user'));
  try{
    const jobId=`${crypto.randomUUID()}.vendor-sync-job`;
    await pool.query(`INSERT INTO vendor_sync_jobs (job_id,feed_type,scheduled_for_date,ad_hoc,created_by,updated_by) VALUES ($1,$2,$3,true,$4,$4)`,[jobId,feed,date,ACTOR]);
    for(let i=0;i<60;i++){ await sleep(3000);
      const r=await pool.query(`SELECT status,last_error FROM vendor_sync_jobs WHERE job_id=$1`,[jobId]); const row=r.rows[0];
      if(row.status==='completed'||row.status==='failed') return {status:row.status,err:row.last_error};
    }
    return {status:'timeout'};
  } finally { await pool.end(); }
}
for(const d of DATES){
  const eq=await runFeed('equity-prices',d);
  const op=await runFeed('options-prices',d);
  console.log(`${d}: equity=${eq.status}${eq.err?' ('+eq.err.slice(0,60)+')':''} options=${op.status}${op.err?' ('+op.err.slice(0,60)+')':''}`);
}
// verify rollups + final price coverage
const pool=createPool(ec,loadPostgresConfig(ec,'rds-user'));
try{
  const roll=await pool.query(`SELECT count(*)::int n FROM job WHERE partition_key LIKE 'yield#%' AND created_at > now() - interval '30 minutes';`);
  console.log('NEW yield rollup jobs (last 30m):', roll.rows[0].n);
}catch(e){console.log('rollup check fail:',e.message);} finally{await pool.end();}
console.log('BACKFILL_DONE');
