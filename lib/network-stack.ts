import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { aws_ec2 as ec2 } from "aws-cdk-lib";

type Props = cdk.StackProps & {
    vpcCidr: string;
    enableNat: boolean;
};

export class NetworkStack extends cdk.Stack {
    public readonly vpc: ec2.Vpc;
    public readonly appClientSg: ec2.SecurityGroup;

    constructor(scope: Construct, id: string, props: Props) {
        super(scope, id, props);

        this.vpc = new ec2.Vpc(this, "VersoStat-Vpc", {
            ipAddresses: ec2.IpAddresses.cidr(props.vpcCidr),
            natGateways: props.enableNat ? 1 : 0,
            maxAzs: 2,
            subnetConfiguration: [
                {
                    name: "public",
                    subnetType: ec2.SubnetType.PUBLIC,
                },
                {
                    name: "private",
                    subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
                },
            ],
        });

        // SG for application/ECS tasks
        this.appClientSg = new ec2.SecurityGroup(
            this,
            "VersoStat-AppClientSg",
            {
                vpc: this.vpc,
                allowAllOutbound: true,
                description:
                    "Security group for app clients that need to talk to Postgres",
            },
        );

        // Useful interface endpoints (keep egress inside VPC, save NAT costs where possible)
        const endpoints: ec2.InterfaceVpcEndpointService[] = [
            ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
            ec2.InterfaceVpcEndpointAwsService.ECR,
            ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
            ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_MONITORING,
            ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
            ec2.InterfaceVpcEndpointAwsService.SSM,
            ec2.InterfaceVpcEndpointAwsService.SSM_MESSAGES,
            ec2.InterfaceVpcEndpointAwsService.EC2_MESSAGES,
        ];

        endpoints.forEach((svc, idx) => {
            new ec2.InterfaceVpcEndpoint(this, `VersoStat-Endpoint${idx}`, {
                vpc: this.vpc,
                service: svc,
                securityGroups: [this.appClientSg],
                subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
            });
        });

        new cdk.CfnOutput(this, "VersoStat-VpcId", { value: this.vpc.vpcId });
        new cdk.CfnOutput(this, "VersoStat-PrivateSubnetIds", {
            value: this.vpc.privateSubnets.map((s) => s.subnetId).join(","),
        });
        new cdk.CfnOutput(this, "VersoStat-AppClientSecurityGroupId", {
            value: this.appClientSg.securityGroupId,
        });
    }
}
