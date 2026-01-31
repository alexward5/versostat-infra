import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { aws_ec2 as ec2, aws_ecr as ecr } from "aws-cdk-lib";

type Props = cdk.StackProps & {
    vpc: ec2.IVpc;
    appClientSg: ec2.ISecurityGroup;
};

export class ScraperPlatformStack extends cdk.Stack {
    public readonly ecrRepo: ecr.Repository;
    public readonly scraperTaskSg: ec2.SecurityGroup;

    constructor(scope: Construct, id: string, props: Props) {
        super(scope, id, props);

        const { vpc, appClientSg } = props;

        // ECR repository for pyscraper images
        this.ecrRepo = new ecr.Repository(this, "VersoStat-PyscraperEcrRepo", {
            repositoryName: "versostat-pyscraper",
            imageScanOnPush: true,
            lifecycleRules: [{ maxImageCount: 10 }],
        });

        // Security group for scraper ECS tasks
        this.scraperTaskSg = new ec2.SecurityGroup(
            this,
            "VersoStat-ScraperTaskSg",
            {
                vpc,
                description: "SG for scraper ECS tasks (Fargate)",
                allowAllOutbound: true,
            }
        );

        // Allow scraper tasks to reach VPC interface endpoints (ECR, Secrets Manager, etc.)
        // Use CfnSecurityGroupIngress so the rule lives in THIS stack; addIngressRule
        // would add it to appClientSg's stack (NetworkStack) and create a cyclic dep.
        new ec2.CfnSecurityGroupIngress(this, "AllowScraperToEndpoints", {
            groupId: appClientSg.securityGroupId,
            sourceSecurityGroupId: this.scraperTaskSg.securityGroupId,
            ipProtocol: "tcp",
            fromPort: 443,
            toPort: 443,
            description: "Scraper tasks to interface endpoints on 443",
        });

        new cdk.CfnOutput(this, "VersoStat-PyscraperEcrRepositoryUri", {
            value: this.ecrRepo.repositoryUri,
            exportName: "VersoStat-PyscraperEcrRepositoryUri",
        });

        new cdk.CfnOutput(this, "VersoStat-ScraperTaskSecurityGroupId", {
            value: this.scraperTaskSg.securityGroupId,
            exportName: "VersoStat-ScraperTaskSecurityGroupId",
        });
    }
}
