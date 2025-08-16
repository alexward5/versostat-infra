#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { NetworkStack } from "../lib/network-stack";
import { DatabaseStack } from "../lib/database-stack";

type StageConfig = {
    account: string;
    region: string;
    vpcCidr: string;
    enableNat: boolean;
    db: {
        engineVersion: string;
        instanceType: string;
        multiAz: boolean;
        allocatedStorageGb: number;
        maxAllocatedStorageGb: number;
        backupRetentionDays: number;
        deletionProtection: boolean;
        publicAccess: boolean;
    };
};

const app = new cdk.App();
const stageKey = app.node.tryGetContext("stage") ?? "dev";
const envs = app.node.tryGetContext("envs") as Record<string, StageConfig>;
const cfg = envs[stageKey];

if (!cfg) {
    throw new Error(`No context for stage "${stageKey}". Check cdk.json`);
}

const env = { account: cfg.account, region: cfg.region };

const net = new NetworkStack(app, "VersoStat-NetworkStack", {
    env,
    description: `VPC and endpoints (${stageKey})`,
    vpcCidr: cfg.vpcCidr,
    enableNat: cfg.enableNat,
});

new DatabaseStack(app, "VersoStat-DatabaseStack", {
    env,
    description: `PostgreSQL RDS (${stageKey})`,
    vpc: net.vpc,
    dbCfg: cfg.db,
    // TODO: will limit inbound to this SG (API tasks can be added to this SG or allowed from theirs)
    appClientSg: net.appClientSg,
}).addDependency(net);
