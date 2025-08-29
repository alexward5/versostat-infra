#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { NetworkStack } from "../lib/network-stack";
import { DatabaseStack } from "../lib/database-stack";
import { AccessStack } from "../lib/access-stack";
import { ApiPlatformStack } from "../lib/api-stack";

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

const net = new NetworkStack(app, `VersoStat-NetworkStack-${stageKey}`, {
    env,
    description: `VPC and endpoints (${stageKey})`,
    vpcCidr: cfg.vpcCidr,
    enableNat: cfg.enableNat,
});

const db = new DatabaseStack(app, `VersoStat-DatabaseStack-${stageKey}`, {
    env,
    description: `PostgreSQL RDS (${stageKey})`,
    vpc: net.vpc,
    dbCfg: cfg.db,
    // TODO: Limit inbound to this SG (API tasks can be added to this SG or allowed from theirs)
    appClientSg: net.appClientSg,
});
db.addDependency(net);

const access = new AccessStack(app, `VersoStat-AccessStack-${stageKey}`, {
    env,
    description: `Bastion for SSM port forwarding (${stageKey})`,
    vpc: net.vpc,
    dbSecurityGroup: db.db.connections.securityGroups[0],
});
access.addDependency(db);

new ApiPlatformStack(app, `VersoStat-ApiPlatformStack-${stageKey}`, {
    env,
    vpc: net.vpc,
    ecrRepoName: "versostat-api",
});
