import { requireInternalRequest } from '../../utils/internal-api';
import { receiveSetupResult } from '../../utils/setup-jobs';
export default defineEventHandler(async event=>{ requireInternalRequest(event); await receiveSetupResult(await readBody(event)); return {ok:true}; });
