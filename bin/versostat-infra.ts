#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { VersoStatInfraStack } from "../lib/versostat-infra-stack";
// import { NetworkStack } from '../lib/network-stack';
// import { DatabaseStack } from '../lib/database-stack';

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
new VersoStatInfraStack(app, "VersoStatInfraStack", {
    /* If you don't specify 'env', this stack will be environment-agnostic.
     * Account/Region-dependent features and context lookups will not work,
     * but a single synthesized template can be deployed anywhere. */
    /* Uncomment the next line to specialize this stack for the AWS Account
     * and Region that are implied by the current CLI configuration. */
    // env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
    /* Uncomment the next line if you know exactly what Account and Region you
     * want to deploy the stack to. */
    // env: { account: '123456789012', region: 'us-east-1' },
    /* For more information, see https://docs.aws.amazon.com/cdk/latest/guide/environments.html */
});
