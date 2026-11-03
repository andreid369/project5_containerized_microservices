# Migrating the Product Service from the EC2 launch type to Fargate

This walks through moving the running service from ECS on EC2 to ECS on Fargate with no downtime and a rollback at every step. The starting point is `cloudformation/migration/1-ec2-baseline.yaml`, a typical EC2 setup; the end point is the Fargate service of `cloudformation/steps/04-ecs-service-alb-autoscaling.yaml`, after which steps 05 to 08 continue as usual.

| Phase | Template | What runs | Traffic |
|---|---|---|---|
| 1 | `migration/1-ec2-baseline.yaml` | EC2 service | 100% EC2 |
| 2 | `migration/2-parallel-run.yaml` | EC2 and Fargate services | 0 → 10 → 50 → 100% Fargate |
| 3 | `migration/3-remove-ec2-service.yaml` | Fargate service (EC2 instances still attached) | 100% Fargate |
| 4 | `steps/04-ecs-service-alb-autoscaling.yaml` | Fargate service only | 100% Fargate |

## The two states side by side

| | EC2 baseline (before) | Fargate (after) |
|---|---|---|
| **Capacity** | Auto Scaling group of ECS-optimized Amazon Linux 2023 instances (2 to 4), registered as a capacity provider with managed scaling and managed draining | `FARGATE` capacity provider (and `FARGATE_SPOT` from step 7); no instances to patch or scale |
| **Service** | `product-service-ec2`, rolling deployments with the circuit breaker, placement: spread across zones, then binpack on memory | `product-service`, CodeDeploy blue/green controller (used from step 6), no placement strategies (Fargate places tasks itself) |
| **Task definition** | Family `product-service-ec2`; `requiresCompatibilities: [EC2]`; `networkMode: bridge`; CPU and memory on the container (`cpu 256`, `memory 512`, `memoryReservation 256`); `hostPort: 0` (dynamic); no execution role | Family `product-service`; `requiresCompatibilities: [FARGATE]`; `networkMode: awsvpc`; task-level `cpu "256"`, `memory "512"` (a supported Fargate combination); `containerPort 3000`, no host port; `executionRoleArn` set; `runtimePlatform` X86_64 |
| **Networking** | Tasks share the host's interface (bridge). The **instance** security group allows the ALB on the dynamic port range 32768-65535 and the database allows the instance group. Instance-type target group | Each task has its own interface in a private subnet with the **task** security group, which allows the ALB on 3000 only; the database allows the task group. IP-type target group |
| **IAM** | Instance role (`AmazonEC2ContainerServiceforEC2Role`, Session Manager) and instance profile: the host registers with the cluster, pulls images and writes logs for every task on it. Task role reads the secret | No instance role or profile. **Execution role** (`AmazonECSTaskExecutionRolePolicy`) pulls the image and writes logs, per task. Same task role |
| **Container hardening** | IMDSv2 required with a hop limit of 1, so containers can't reach the instance role's credentials | Nothing to block: Fargate tasks have no instance metadata service |
| **Scaling** | Two layers: service Auto Scaling (tasks) and the capacity provider (instances) | One layer: service Auto Scaling |

The application image, its environment and its health checks are identical on both, which is what makes running the two side by side safe.

## Why a parallel run instead of an in-place update

An in-place switch isn't possible for this change. The network mode moves from `bridge` to `awsvpc`, which needs an IP-type target group instead of an instance-type one, and a service's target group, launch configuration and network mode are fixed for practical purposes. So the Fargate service is created next to the EC2 one, both sit behind the same listener with weighted forwarding, and traffic moves across in steps you can stop and reverse.

## Procedure

Same stack name throughout. Steps 02 (ECR and an image) must be done first.

### 1. Deploy the EC2 baseline

```bash
aws cloudformation deploy --stack-name "$STACK" \
  --template-file cloudformation/migration/1-ec2-baseline.yaml \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides ImageTag=1.0.0

curl "$(out ProductsUrl)"
aws ecs describe-services --cluster product-service --services product-service-ec2 \
  --query 'services[0].{running:runningCount,desired:desiredCount,cp:capacityProviderStrategy}'
aws ecs list-container-instances --cluster product-service
```

### 2. Start the parallel run, with no traffic on Fargate

`2-parallel-run.yaml` adds everything Fargate needs (execution role, Fargate task definition, task security group, IP target group, the `product-service` service and its Auto Scaling) and changes the listener to weighted forwarding. It adds `FARGATE` to the cluster and makes it the default strategy; the EC2 service names its own strategy, so it stays on EC2.

```bash
aws cloudformation deploy --stack-name "$STACK" \
  --template-file cloudformation/migration/2-parallel-run.yaml \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides FargateTrafficPercent=0

# Both services healthy; Fargate tasks registered but receiving no traffic
aws ecs describe-services --cluster product-service --services product-service-ec2 product-service \
  --query 'services[].{name:serviceName,running:runningCount}'
aws elbv2 describe-target-health --target-group-arn "$(aws elbv2 describe-target-groups \
  --query "TargetGroups[?TargetType=='ip'].TargetGroupArn | [0]" --output text)"
```

### 3. Shift traffic: 10%, then 50%, then 100%

```bash
for pct in 10 50 100; do
  aws cloudformation deploy --stack-name "$STACK" \
    --template-file cloudformation/migration/2-parallel-run.yaml \
    --capabilities CAPABILITY_IAM --parameter-overrides FargateTrafficPercent=$pct
  echo "Now $pct% on Fargate. Check errors and latency before continuing."
  read -r -p "Continue? (Ctrl-C to stop) "
done
```

Between steps, watch the ALB's 5XX count and response time per target group in CloudWatch, and the application logs (`aws logs tail /ecs/product-service --follow`; EC2 tasks log under the `app-ec2` stream prefix, Fargate tasks under `app`).

**Rollback** at any point: deploy `2-parallel-run.yaml` again with `FargateTrafficPercent=0`. Traffic is back on EC2 as soon as the listener updates.

### 4. Remove the EC2 service

Once 100% has been stable for as long as you need, deploy `3-remove-ec2-service.yaml`. It points the listener at the Fargate target group alone (no weights) and deletes the EC2 service and its Auto Scaling. The EC2 capacity provider and instances stay for this one update: ECS won't remove a capacity provider from the cluster while a service still uses it, and CloudFormation applies updates before deletions, so the service has to go in an update of its own.

```bash
aws cloudformation deploy --stack-name "$STACK" \
  --template-file cloudformation/migration/3-remove-ec2-service.yaml \
  --capabilities CAPABILITY_IAM

aws ecs list-services --cluster product-service              # only product-service
```

Rolling back from here means redeploying `2-parallel-run.yaml` with `FargateTrafficPercent=0`, which recreates the EC2 service (a few minutes).

### 5. Remove the EC2 capacity

Deploy step 04. The Fargate service is unchanged. The cluster drops the EC2 capacity provider, and the stack deletes it along with the Auto Scaling group (terminating the instances), launch template, instance role and profile, instance security group and its rules, the EC2 task definition and the instance target group.

```bash
aws cloudformation deploy --stack-name "$STACK" \
  --template-file cloudformation/steps/04-ecs-service-alb-autoscaling.yaml \
  --capabilities CAPABILITY_IAM

aws ecs list-container-instances --cluster product-service   # empty
aws ecs describe-clusters --clusters product-service --query 'clusters[0].capacityProviders'   # ["FARGATE"]
```

Then continue with steps 05 (dashboard), 06 (CI/CD), 07 (Fargate Spot) and 08 (Secrets Manager) as in the README.

## Things to check in your own migration

- **Resource sizing.** On EC2, a container's `memoryReservation` is a soft limit and the host may have spare capacity; on Fargate the task gets exactly its task-level CPU and memory. Compare actual usage (Container Insights) before choosing the Fargate size.
- **Anything that depends on the host:** host volumes, `privileged`, Docker socket mounts, daemon tasks, GPUs and custom AMIs aren't available on Fargate. This service uses none of them.
- **Security group rules that name the instance group** (the database, other services) need an equivalent rule for the task group before traffic moves. Here both exist during the parallel run.
- **IP address consumption.** Each Fargate task uses one IP address in its subnet. Check subnet sizes when the task count is high.
- **Cost model.** EC2 is billed per instance whether full or empty; Fargate per task size and second. At this service's size Fargate is cheaper; with large, densely packed instances it can be the other way around.
