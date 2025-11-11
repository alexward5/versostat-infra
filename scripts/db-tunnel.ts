#!/usr/bin/env ts-node

/**
 * Start an SSM port-forwarding session to the RDS instance via bastion.
 *
 * Usage:
 *   npx ts-node scripts/db-tunnel.ts \
 *     --region us-east-1 \
 *     --access-stack VersoStat-AccessStack \
 *     --db-stack VersoStat-DatabaseStack \
 *     --local-port 5439
 *
 * Requires:
 *   - AWS CLI v2 installed and on PATH
 *   - Your CDK stacks to output:
 *       AccessStack: BastionInstanceId
 *       DatabaseStack: DbEndpoint
 */

import {
    CloudFormationClient,
    DescribeStacksCommand,
} from "@aws-sdk/client-cloudformation";
import { spawn } from "child_process";

type Args = {
    region: string;
    accessStack: string;
    dbStack: string;
    localPort: number;
};

function parseArgs(): Args {
    const args = process.argv.slice(2);
    const get = (k: string, def?: string) => {
        const i = args.indexOf(`--${k}`);
        return i >= 0 ? args[i + 1] : def;
    };

    const region = get("region") || process.env.AWS_REGION || "us-east-1";
    const accessStack = get("access-stack") || "VersoStat-AccessStack";
    const dbStack = get("db-stack") || "VersoStat-DatabaseStack";
    const localPort = Number(get("local-port") || 5439);

    if (!region) throw new Error("Missing --region");
    if (!accessStack) throw new Error("Missing --access-stack");
    if (!dbStack) throw new Error("Missing --db-stack");
    if (!localPort || Number.isNaN(localPort))
        throw new Error("Invalid --local-port");

    return { region, accessStack, dbStack, localPort };
}

async function getStackOutput(
    cf: CloudFormationClient,
    stackName: string,
    outputKey: string,
): Promise<string> {
    const resp = await cf.send(
        new DescribeStacksCommand({ StackName: stackName }),
    );
    const stack = resp.Stacks?.[0];
    if (!stack) throw new Error(`Stack not found: ${stackName}`);
    const val = stack.Outputs?.find(
        (o) => o.OutputKey === outputKey,
    )?.OutputValue;
    if (!val) throw new Error(`Output ${outputKey} not found in ${stackName}`);
    return val;
}

async function main() {
    const { region, accessStack, dbStack, localPort } = parseArgs();
    const cf = new CloudFormationClient({ region });

    const bastionId = await getStackOutput(
        cf,
        accessStack,
        "VersoStatBastionInstanceId",
    );
    const dbEndpoint = await getStackOutput(cf, dbStack, "VersoStatDbHost");

    console.log("=== SSM Port Forward Parameters ===");
    console.log(`Region:         ${region}`);
    console.log(`Bastion ID:     ${bastionId}`);
    console.log(`DB Endpoint:    ${dbEndpoint}`);
    console.log(`Local Port:     ${localPort}`);
    console.log("===================================");

    // Build the AWS CLI command. We use the hostname (recommended); SSM will resolve it from the bastion.
    const paramsJson = JSON.stringify({
        host: [dbEndpoint],
        portNumber: ["5432"],
        localPortNumber: [String(localPort)],
    });

    const child = spawn(
        "aws",
        [
            "ssm",
            "start-session",
            "--region",
            region,
            "--target",
            bastionId,
            "--document-name",
            "AWS-StartPortForwardingSessionToRemoteHost",
            "--parameters",
            paramsJson,
        ],
        { stdio: "inherit" },
    );

    child.on("exit", (code) => {
        console.log(`\nSSM session exited with code ${code}`);
    });

    console.log(
        `\nWhen connected, point pgAdmin/psql to host 127.0.0.1 port ${localPort} (db name: appdb, user/pass from Secrets Manager).`,
    );
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
