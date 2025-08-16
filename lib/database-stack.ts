import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import {
    aws_ec2 as ec2,
    aws_rds as rds,
    aws_secretsmanager as secrets,
    aws_cloudwatch as cw,
} from "aws-cdk-lib";

type DbCfg = {
    engineVersion: string;
    instanceType: string;
    multiAz: boolean;
    allocatedStorageGb: number;
    maxAllocatedStorageGb: number;
    backupRetentionDays: number;
    deletionProtection: boolean;
    publicAccess: boolean;
};

type Props = cdk.StackProps & {
    vpc: ec2.IVpc;
    dbCfg: DbCfg;
    appClientSg: ec2.ISecurityGroup;
};

export class DatabaseStack extends cdk.Stack {
    public readonly db: rds.DatabaseInstance;
    public readonly secret: secrets.ISecret;

    constructor(scope: Construct, id: string, props: Props) {
        super(scope, id, props);

        const { vpc, dbCfg, appClientSg } = props;

        const dbSg = new ec2.SecurityGroup(this, "VersoStat-DbSg", {
            vpc,
            description: "RDS PostgreSQL security group",
        });

        dbSg.addIngressRule(
            appClientSg,
            ec2.Port.tcp(5432),
            "DB ingress rule (from app clients)",
        );

        // Master user secret (username + random password)
        const secret = new secrets.Secret(this, "VersoStat-DbCredentials", {
            generateSecretString: {
                secretStringTemplate: JSON.stringify({ username: "dbadmin" }),
                generateStringKey: "password",
                excludeCharacters: '/@"\\',
                passwordLength: 30,
            },
        });
        this.secret = secret;

        // Engine & parameter group
        const engine = rds.DatabaseInstanceEngine.postgres({
            version: rds.PostgresEngineVersion.of(
                dbCfg.engineVersion,
                dbCfg.engineVersion.split(".")[0],
            ),
        });

        const pgParams = new rds.ParameterGroup(
            this,
            "VersoStat-PostgresParams",
            {
                engine,
                parameters: {
                    // TODO: Review these parameters
                    "rds.force_ssl": "1",
                },
            },
        );

        this.db = new rds.DatabaseInstance(this, "VersoStat-Postgres", {
            vpc,
            engine,
            credentials: rds.Credentials.fromSecret(secret),
            instanceType: new ec2.InstanceType(dbCfg.instanceType),
            vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
            securityGroups: [dbSg],
            multiAz: dbCfg.multiAz,
            allocatedStorage: dbCfg.allocatedStorageGb,
            maxAllocatedStorage: dbCfg.maxAllocatedStorageGb,
            storageEncrypted: true,
            deletionProtection: dbCfg.deletionProtection,
            backupRetention: cdk.Duration.days(dbCfg.backupRetentionDays),
            cloudwatchLogsExports: ["postgresql"],
            autoMinorVersionUpgrade: true,
            publiclyAccessible: dbCfg.publicAccess,
            parameterGroup: pgParams,
            databaseName: "versostat_db",
        });

        new cw.Alarm(this, "VersoStat-DbCpuHigh", {
            metric: this.db.metricCPUUtilization(),
            threshold: 80,
            evaluationPeriods: 3,
            datapointsToAlarm: 2,
            comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
        });

        new cw.Alarm(this, "VersoStat-DbFreeStorageLow", {
            metric: this.db.metricFreeStorageSpace(),
            threshold: 10 * 1024 * 1024 * 1024, // 10 GiB
            evaluationPeriods: 1,
            comparisonOperator: cw.ComparisonOperator.LESS_THAN_THRESHOLD,
        });

        new cdk.CfnOutput(this, "VersoStat-DbEndpoint", {
            value: this.db.instanceEndpoint.hostname,
        });
        new cdk.CfnOutput(this, "VersoStat-DbPort", {
            value: String(this.db.instanceEndpoint.port),
        });
        new cdk.CfnOutput(this, "VersoStat-DbSecretArn", {
            value: secret.secretArn,
        });
        new cdk.CfnOutput(this, "VersoStat-DbSecurityGroupId", {
            value: dbSg.securityGroupId,
        });
    }
}
