import { getAppSession } from "~~/server/utils/supabase";

export default defineEventHandler(event => getAppSession(event));
