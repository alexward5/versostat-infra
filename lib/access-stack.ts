import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { aws_ec2 as ec2, aws_iam as iam } from "aws-cdk-lib";

type Props = cdk.StackProps & {
    vpc: ec2.IVpc;
    // SG on the database that must allow inbound from this bastion
    dbSecurityGroup: ec2.ISecurityGroup;
};

export class AccessStack extends cdk.Stack {
    public readonly bastionSg: ec2.SecurityGroup;
    public readonly bastion: ec2.BastionHostLinux;

    constructor(scope: Construct, id: string, props: Props) {
        super(scope, id, props);

        // SG for the bastion itself
        this.bastionSg = new ec2.SecurityGroup(this, "VersoStat-BastionSg", {
            vpc: props.vpc,
            allowAllOutbound: true,
            description: "Bastion used for SSM port forwarding to RDS",
        });

        // Private subnet bastion; no public IP; uses SSM
        this.bastion = new ec2.BastionHostLinux(this, "VersoStat-Bastion", {
            vpc: props.vpc,
            subnetSelection: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
            securityGroup: this.bastionSg,
            machineImage: ec2.MachineImage.latestAmazonLinux2023(),
        });

        // Egress rule to allow the bastion to connect to the database
        this.bastion.connections.allowTo(
            props.dbSecurityGroup,
            ec2.Port.tcp(5432),
            "Bastion to Postgres egress rule",
        );

        // Enable SSM on the instance
        this.bastion.instance.role.addManagedPolicy(
            iam.ManagedPolicy.fromAwsManagedPolicyName(
                "AmazonSSMManagedInstanceCore",
            ),
        );

        new cdk.CfnOutput(this, "VersoStat-BastionInstanceId", {
            value: this.bastion.instance.instanceId,
        });
    }
}
