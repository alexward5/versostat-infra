#!/usr/bin/env ts-node

/**
 * Start an SSM port-forwarding session to the RDS instance via bastion.
 *
 * Usage:
 *   npx ts-node scripts/db-tunnel.ts \
 *     --region us-east-1 \
 *     --access-stack VersoStat-AccessStack-prod \
 *     --db-stack VersoStat-DatabaseStack-prod \
 *     --local-port 5439
 *
 * Requires:
 *   - AWS CLI v2 installed and on PATH
 *   - AWS credentials configured (profile or env vars)
 *   - CDK stacks to output:
 *       AccessStack:  VersoStatBastionInstanceId
 *       DatabaseStack: VersoStatDbHost
 */

import {
    CloudFormationClient,
    DescribeStacksCommand,
} from "@aws-sdk/client-cloudformation";
import {
    EC2Client,
    DescribeInstancesCommand,
    StartInstancesCommand,
    StopInstancesCommand,
    InstanceStateName,
} from "@aws-sdk/client-ec2";
import { ChildProcess, spawn } from "child_process";

type Args = {
    region: string;
    accessStack: string;
    dbStack: string;
    localPort: number;
};

let ec2Global: EC2Client | undefined;
let bastionIdGlobal: string | undefined;
let childGlobal: ChildProcess | undefined;

function parseArgs(): Args {
    const args = process.argv.slice(2);
    const get = (k: string, def?: string) => {
        const i = args.indexOf(`--${k}`);
        return i >= 0 ? args[i + 1] : def;
    };

    const region = get("region") || process.env.AWS_REGION || "us-east-1";
    const accessStack = get("access-stack") || "VersoStat-AccessStack-prod";
    const dbStack = get("db-stack") || "VersoStat-DatabaseStack-prod";
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

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getInstanceState(
    ec2: EC2Client,
    instanceId: string,
): Promise<InstanceStateName | undefined> {
    const resp = await ec2.send(
        new DescribeInstancesCommand({ InstanceIds: [instanceId] }),
    );
    const reservations = resp.Reservations ?? [];
    const inst = reservations[0]?.Instances?.[0];
    return inst?.State?.Name as InstanceStateName | undefined;
}

async function ensureInstanceRunning(
    ec2: EC2Client,
    instanceId: string,
    timeoutMs = 5 * 60 * 1000, // 5 min safety timeout
): Promise<void> {
    const start = Date.now();

    for (;;) {
        const state = await getInstanceState(ec2, instanceId);
        console.log(`Current bastion state: ${state}`);

        if (state === "running") {
            console.log(`Bastion ${instanceId} is running.`);
            return;
        }

        if (state === "terminated" || state === "shutting-down") {
            throw new Error(
                `Bastion ${instanceId} is in terminal state: ${state}`,
            );
        }

        // If it's still stopping, just wait until it finishes
        if (state === "stopping") {
            if (Date.now() - start > timeoutMs) {
                throw new Error(
                    `Timed out waiting for bastion ${instanceId} to finish stopping`,
                );
            }
            await sleep(5000);
            continue;
        }

        // If fully stopped, start it
        if (state === "stopped" || state === undefined) {
            console.log(
                `Bastion ${instanceId} is in state "${state}". Starting...`,
            );
            await ec2.send(
                new StartInstancesCommand({ InstanceIds: [instanceId] }),
            );
        }

        if (Date.now() - start > timeoutMs) {
            throw new Error(
                `Timed out waiting for bastion ${instanceId} to become running`,
            );
        }

        await sleep(5000);
    }
}

async function stopInstance(ec2: EC2Client, instanceId: string): Promise<void> {
    console.log(`Stopping bastion ${instanceId}...`);
    await ec2.send(new StopInstancesCommand({ InstanceIds: [instanceId] }));
}

async function cleanupAndExit(code: number) {
    if (childGlobal && !childGlobal.killed) {
        try {
            childGlobal.kill("SIGINT");
        } catch {
            // ignore
        }
    }

    if (ec2Global && bastionIdGlobal) {
        try {
            console.log("\nStopping bastion before exit...");
            await stopInstance(ec2Global, bastionIdGlobal);
            console.log("Bastion stopped.");
        } catch (e) {
            console.error("Failed to stop bastion:", e);
        }
    }
    process.exit(code);
}

process.on("SIGTERM", () => {
    void cleanupAndExit(143);
});

process.on("SIGINT", () => {
    // Ctrl+C
    void cleanupAndExit(130);
});

process.on("SIGTSTP", () => {
    // Ctrl+Z
    void cleanupAndExit(148);
});

async function main() {
    const { region, accessStack, dbStack, localPort } = parseArgs();
    const cf = new CloudFormationClient({ region });
    const ec2 = new EC2Client({ region });

    // NOTE: These output keys must match your CDK CfnOutput names
    const bastionId = await getStackOutput(
        cf,
        accessStack,
        "VersoStatBastionInstanceId",
    );

    ec2Global = ec2;
    bastionIdGlobal = bastionId;

    const dbEndpoint = await getStackOutput(cf, dbStack, "VersoStatDbHost");

    await ensureInstanceRunning(ec2, bastionId);

    await sleep(10000);

    console.log("=== SSM Port Forward Parameters ===");
    console.log(`Region:         ${region}`);
    console.log(`Bastion ID:     ${bastionId}`);
    console.log(`DB Endpoint:    ${dbEndpoint}`);
    console.log(`Local Port:     ${localPort}`);
    console.log("===================================");

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

    childGlobal = child;

    child.on("exit", async (code) => {
        console.log(`\nSSM session exited with code ${code}`);
        try {
            await stopInstance(ec2, bastionId);
            console.log("Bastion stopped.");
        } catch (e) {
            console.error("Failed to stop bastion:", e);
        }
    });

    console.log(
        `\nWhen connected, point pgAdmin/psql to host 127.0.0.1 port ${localPort} (db name: versostat_db, user/pass from Secrets Manager).`,
    );
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
