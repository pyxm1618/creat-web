import "server-only";

import { featuresConfig } from "@/config/features.config";

import { loadRuntimeEnv } from "./load-runtime-config";

export const env = loadRuntimeEnv(process.env, featuresConfig);
