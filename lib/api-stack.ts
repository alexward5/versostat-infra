import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import {
    aws_ec2 as ec2,
    aws_ecr as ecr,
    aws_ecs as ecs,
    aws_elasticloadbalancingv2 as elbv2,
    aws_logs as logs,
    aws_certificatemanager as acm,
    aws_route53 as route53,
    aws_route53_targets as r53Targets,
} from "aws-cdk-lib";

type Props = cdk.StackProps & {
    vpc: ec2.IVpc;
    // Optionally pass a name for the ECR repo
    ecrRepoName?: string;
};

export class ApiPlatformStack extends cdk.Stack {
    public readonly ecrRepo: ecr.Repository;
    public readonly cluster: ecs.Cluster;
    public readonly taskSg: ec2.SecurityGroup;
    public readonly alb: elbv2.ApplicationLoadBalancer;
    public readonly httpListener: elbv2.ApplicationListener;
    public readonly logGroup: logs.LogGroup;

    constructor(scope: Construct, id: string, props: Props) {
        super(scope, id, props);

        const { vpc } = props;

        // ECR repo (no image dependency)
        this.ecrRepo = new ecr.Repository(this, "VersoStat-ApiEcrRepo", {
            repositoryName: props.ecrRepoName ?? "versostat-api",
            imageScanOnPush: true,
            lifecycleRules: [{ maxImageCount: 50 }],
        });

        // ECS cluster w/ Fargate CPs
        this.cluster = new ecs.Cluster(this, "VersoStat-ApiCluster", { vpc });
        this.cluster.enableFargateCapacityProviders();

        // Logs (optionally re-used by service)
        this.logGroup = new logs.LogGroup(this, "VersoStat-ApiLogGroup", {
            retention: logs.RetentionDays.ONE_MONTH,
        });

        // Security Group for ECS tasks (the service will use this)
        this.taskSg = new ec2.SecurityGroup(this, "VersoStat-ApiServiceSg", {
            vpc,
            description: "SG for ECS tasks behind ALB",
            allowAllOutbound: true,
        });

        const appClientSgId = cdk.Fn.importValue(
            "VersoStat-AppClientSecurityGroupId",
        );

        const appClientSg = ec2.SecurityGroup.fromSecurityGroupId(
            this,
            "AppClientSg",
            appClientSgId,
        );

        const albSg = new ec2.SecurityGroup(this, "VersoStat-ApiAlbSg", {
            vpc,
            description: "SG for public ALB",
            allowAllOutbound: true,
        });

        // Public ALB (internet-facing)
        this.alb = new elbv2.ApplicationLoadBalancer(this, "VersoStat-ApiAlb", {
            vpc,
            internetFacing: true,
            vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
            securityGroup: albSg,
        });

        // Allow HTTP 80 on ALB SG
        albSg.addIngressRule(
            ec2.Peer.anyIpv4(),
            ec2.Port.tcp(80),
            "Allow HTTP",
        );

        // Allow HTTPS 443 on ALB SG
        albSg.addIngressRule(
            ec2.Peer.anyIpv4(),
            ec2.Port.tcp(443),
            "Allow HTTPS",
        );

        this.taskSg.addIngressRule(
            albSg,
            ec2.Port.tcp(4000),
            "ALB to app port 4000",
        );

        // Allow HTTP 80 on ALB SG
        this.alb.connections.securityGroups[0].addIngressRule(
            ec2.Peer.anyIpv4(),
            ec2.Port.tcp(80),
            "Allow HTTP",
        );

        // Allow ECS tasks to reach VPC interface endpoints (ECR, SSM, etc.) on 443
        appClientSg.addIngressRule(
            this.taskSg,
            ec2.Port.tcp(443),
            "Allow ECS tasks to reach interface endpoints on 443",
        );

        // HTTP listener w/ placeholder default action (service will add its own listener)
        this.httpListener = this.alb.addListener("PublicHttpListener", {
            port: 80,
            protocol: elbv2.ApplicationProtocol.HTTP,
            open: true,
            defaultAction: elbv2.ListenerAction.fixedResponse(200, {
                contentType: "text/plain",
                messageBody:
                    "VersoStat API platform is up. Service not attached yet.",
            }),
        });

        // Lookup public hosted zone (Route 53 must be authoritative for versostat.com)
        const zone = route53.HostedZone.fromLookup(this, "ApiZone", {
            domainName: "versostat.com",
        });

        // ACM certificate for api.versostat.com (same region as ALB)
        const apiCert = new acm.Certificate(this, "ApiCert", {
            domainName: "api.versostat.com",
            validation: acm.CertificateValidation.fromDns(zone),
        });

        // HTTPS listener on ALB (TLS terminates here)
        const httpsListener = new elbv2.ApplicationListener(
            this,
            "HttpsListener",
            {
                loadBalancer: this.alb,
                port: 443,
                protocol: elbv2.ApplicationProtocol.HTTPS,
                certificates: [apiCert],
                defaultAction: elbv2.ListenerAction.fixedResponse(404, {
                    messageBody: "Not Found",
                }),
                open: true,
            },
        );

        // DNS: api.versostat.com -> ALB
        new route53.ARecord(this, "ApiAliasA", {
            zone,
            recordName: "api",
            target: route53.RecordTarget.fromAlias(
                new r53Targets.LoadBalancerTarget(this.alb),
            ),
        });
        new route53.AaaaRecord(this, "ApiAliasAAAA", {
            zone,
            recordName: "api",
            target: route53.RecordTarget.fromAlias(
                new r53Targets.LoadBalancerTarget(this.alb),
            ),
        });

        new cdk.CfnOutput(this, "VersoStat-ClusterName", {
            value: this.cluster.clusterName,
            exportName: "VersoStat-ClusterName",
        });

        new cdk.CfnOutput(this, "VersoStat-ClusterArn", {
            value: this.cluster.clusterArn,
            exportName: "VersoStat-ClusterArn",
        });

        new cdk.CfnOutput(this, "VersoStat-TaskSecurityGroupId", {
            value: this.taskSg.securityGroupId,
            exportName: "VersoStat-TaskSecurityGroupId",
        });

        new cdk.CfnOutput(this, "VersoStat-AlbArn", {
            value: this.alb.loadBalancerArn,
            exportName: "VersoStat-AlbArn",
        });

        new cdk.CfnOutput(this, "VersoStat-AlbDnsName", {
            value: this.alb.loadBalancerDnsName,
            exportName: "VersoStat-AlbDnsName",
        });

        new cdk.CfnOutput(this, "VersoStat-HttpListenerArn", {
            value: this.httpListener.listenerArn,
            exportName: "VersoStat-HttpListenerArn",
        });

        new cdk.CfnOutput(this, "HttpsListenerArn", {
            value: httpsListener.listenerArn,
            exportName: "VersoStat-HttpsListenerArn",
        });

        new cdk.CfnOutput(this, "VersoStat-EcrRepositoryUri", {
            value: this.ecrRepo.repositoryUri,
            exportName: "VersoStat-EcrRepositoryUri",
        });

        new cdk.CfnOutput(this, "VersoStat-AlbFullName", {
            value: this.alb.loadBalancerFullName,
            exportName: "VersoStat-AlbFullName",
        });
    }
}
