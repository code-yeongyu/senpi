import { expect, test } from "vitest";
import { BashArity } from "../../src/core/extensions/builtin/permission-system/arity.js";

test("arity 1 - unknown commands default to first token", () => {
	expect(BashArity.prefix(["unknown", "command", "subcommand"])).toEqual(["unknown"]);
	expect(BashArity.prefix(["touch", "foo.txt"])).toEqual(["touch"]);
});

test("arity 2 - two token commands", () => {
	expect(BashArity.prefix(["git", "checkout", "main"])).toEqual(["git", "checkout"]);
	expect(BashArity.prefix(["docker", "run", "nginx"])).toEqual(["docker", "run"]);
});

test("arity 3 - three token commands", () => {
	expect(BashArity.prefix(["aws", "s3", "ls", "my-bucket"])).toEqual(["aws", "s3", "ls"]);
	expect(BashArity.prefix(["npm", "run", "dev", "script"])).toEqual(["npm", "run", "dev"]);
});

test("longest match wins - nested prefixes", () => {
	expect(BashArity.prefix(["docker", "compose", "up", "service"])).toEqual(["docker", "compose", "up"]);
	expect(BashArity.prefix(["consul", "kv", "get", "config"])).toEqual(["consul", "kv", "get"]);
});

test("exact length matches", () => {
	expect(BashArity.prefix(["git", "checkout"])).toEqual(["git", "checkout"]);
	expect(BashArity.prefix(["npm", "run", "dev"])).toEqual(["npm", "run", "dev"]);
});

test("edge cases", () => {
	expect(BashArity.prefix([])).toEqual([]);
	expect(BashArity.prefix(["single"])).toEqual(["single"]);
	expect(BashArity.prefix(["git"])).toEqual(["git"]);
});

test("git commit -m message", () => {
	expect(BashArity.prefix(["git", "commit", "-m", "x"])).toEqual(["git", "commit"]);
});

test("npm run dev", () => {
	expect(BashArity.prefix(["npm", "run", "dev"])).toEqual(["npm", "run", "dev"]);
});

test("rm -rf /", () => {
	expect(BashArity.prefix(["rm", "-rf", "/"])).toEqual(["rm"]);
});

test("docker compose up -d", () => {
	expect(BashArity.prefix(["docker", "compose", "up", "-d"])).toEqual(["docker", "compose", "up"]);
});

test("cargo add tokio", () => {
	expect(BashArity.prefix(["cargo", "add", "tokio"])).toEqual(["cargo", "add", "tokio"]);
});

test("bun run dev", () => {
	expect(BashArity.prefix(["bun", "run", "dev"])).toEqual(["bun", "run", "dev"]);
});

test("pnpm dlx create-next-app", () => {
	expect(BashArity.prefix(["pnpm", "dlx", "create-next-app"])).toEqual(["pnpm", "dlx", "create-next-app"]);
});

test("yarn dlx create-react-app", () => {
	expect(BashArity.prefix(["yarn", "dlx", "create-react-app"])).toEqual(["yarn", "dlx", "create-react-app"]);
});

test("terraform workspace select prod", () => {
	expect(BashArity.prefix(["terraform", "workspace", "select", "prod"])).toEqual(["terraform", "workspace", "select"]);
});

test("kubectl kustomize overlays/dev", () => {
	expect(BashArity.prefix(["kubectl", "kustomize", "overlays/dev"])).toEqual(["kubectl", "kustomize", "overlays/dev"]);
});

test("eksctl create cluster", () => {
	expect(BashArity.prefix(["eksctl", "create", "cluster"])).toEqual(["eksctl", "create", "cluster"]);
});

test("kind create cluster", () => {
	expect(BashArity.prefix(["kind", "create", "cluster"])).toEqual(["kind", "create", "cluster"]);
});

test("openssl req -new -key key.pem", () => {
	expect(BashArity.prefix(["openssl", "req", "-new", "-key", "key.pem"])).toEqual(["openssl", "req", "-new"]);
});

test("ip addr show", () => {
	expect(BashArity.prefix(["ip", "addr", "show"])).toEqual(["ip", "addr", "show"]);
});

test("mc admin info myminio", () => {
	expect(BashArity.prefix(["mc", "admin", "info", "myminio"])).toEqual(["mc", "admin", "info"]);
});

test("pulumi stack output", () => {
	expect(BashArity.prefix(["pulumi", "stack", "output"])).toEqual(["pulumi", "stack", "output"]);
});

test("vault kv get secret/api", () => {
	expect(BashArity.prefix(["vault", "kv", "get", "secret/api"])).toEqual(["vault", "kv", "get"]);
});

test("deno task dev", () => {
	expect(BashArity.prefix(["deno", "task", "dev"])).toEqual(["deno", "task", "dev"]);
});

test("pip install numpy", () => {
	expect(BashArity.prefix(["pip", "install", "numpy"])).toEqual(["pip", "install"]);
});

test("python -m venv env", () => {
	expect(BashArity.prefix(["python", "-m", "venv", "env"])).toEqual(["python", "-m"]);
});

test("cd /path/to/dir", () => {
	expect(BashArity.prefix(["cd", "/path/to/dir"])).toEqual(["cd"]);
});

test("ls -la", () => {
	expect(BashArity.prefix(["ls", "-la"])).toEqual(["ls"]);
});

test("cat file.txt", () => {
	expect(BashArity.prefix(["cat", "file.txt"])).toEqual(["cat"]);
});

test("mkdir new-dir", () => {
	expect(BashArity.prefix(["mkdir", "new-dir"])).toEqual(["mkdir"]);
});

test("mv old.txt new.txt", () => {
	expect(BashArity.prefix(["mv", "old.txt", "new.txt"])).toEqual(["mv"]);
});

test("cp source.txt dest.txt", () => {
	expect(BashArity.prefix(["cp", "source.txt", "dest.txt"])).toEqual(["cp"]);
});

test("chmod 755 script.sh", () => {
	expect(BashArity.prefix(["chmod", "755", "script.sh"])).toEqual(["chmod"]);
});

test("chown user:group file.txt", () => {
	expect(BashArity.prefix(["chown", "user:group", "file.txt"])).toEqual(["chown"]);
});

test("ln -s source target", () => {
	expect(BashArity.prefix(["ln", "-s", "source", "target"])).toEqual(["ln"]);
});

test("tail -f log.txt", () => {
	expect(BashArity.prefix(["tail", "-f", "log.txt"])).toEqual(["tail"]);
});

test("grep pattern file.txt", () => {
	expect(BashArity.prefix(["grep", "pattern", "file.txt"])).toEqual(["grep"]);
});

test("ps aux", () => {
	expect(BashArity.prefix(["ps", "aux"])).toEqual(["ps"]);
});

test("kill 1234", () => {
	expect(BashArity.prefix(["kill", "1234"])).toEqual(["kill"]);
});

test("killall process", () => {
	expect(BashArity.prefix(["killall", "process"])).toEqual(["killall"]);
});

test("which node", () => {
	expect(BashArity.prefix(["which", "node"])).toEqual(["which"]);
});

test("echo hello world", () => {
	expect(BashArity.prefix(["echo", "hello", "world"])).toEqual(["echo"]);
});

test("export PATH=/usr/bin", () => {
	expect(BashArity.prefix(["export", "PATH=/usr/bin"])).toEqual(["export"]);
});

test("unset VAR", () => {
	expect(BashArity.prefix(["unset", "VAR"])).toEqual(["unset"]);
});

test("source ~/.bashrc", () => {
	expect(BashArity.prefix(["source", "~/.bashrc"])).toEqual(["source"]);
});

test("sleep 5", () => {
	expect(BashArity.prefix(["sleep", "5"])).toEqual(["sleep"]);
});

test("pwd", () => {
	expect(BashArity.prefix(["pwd"])).toEqual(["pwd"]);
});

test("rmdir empty-dir", () => {
	expect(BashArity.prefix(["rmdir", "empty-dir"])).toEqual(["rmdir"]);
});

test("env", () => {
	expect(BashArity.prefix(["env"])).toEqual(["env"]);
});

test("aws s3 ls", () => {
	expect(BashArity.prefix(["aws", "s3", "ls"])).toEqual(["aws", "s3", "ls"]);
});

test("az storage blob list", () => {
	expect(BashArity.prefix(["az", "storage", "blob", "list"])).toEqual(["az", "storage", "blob"]);
});

test("gcloud compute instances list", () => {
	expect(BashArity.prefix(["gcloud", "compute", "instances", "list"])).toEqual(["gcloud", "compute", "instances"]);
});

test("gh pr list", () => {
	expect(BashArity.prefix(["gh", "pr", "list"])).toEqual(["gh", "pr", "list"]);
});

test("doctl kubernetes cluster list", () => {
	expect(BashArity.prefix(["doctl", "kubernetes", "cluster", "list"])).toEqual(["doctl", "kubernetes", "cluster"]);
});

test("sfdx force:org:list", () => {
	expect(BashArity.prefix(["sfdx", "force:org:list"])).toEqual(["sfdx", "force:org:list"]);
});

test("brew install node", () => {
	expect(BashArity.prefix(["brew", "install", "node"])).toEqual(["brew", "install"]);
});

test("bazel build", () => {
	expect(BashArity.prefix(["bazel", "build"])).toEqual(["bazel", "build"]);
});

test("cargo build", () => {
	expect(BashArity.prefix(["cargo", "build"])).toEqual(["cargo", "build"]);
});

test("cargo run main", () => {
	expect(BashArity.prefix(["cargo", "run", "main"])).toEqual(["cargo", "run", "main"]);
});

test("cdk deploy", () => {
	expect(BashArity.prefix(["cdk", "deploy"])).toEqual(["cdk", "deploy"]);
});

test("cf push app", () => {
	expect(BashArity.prefix(["cf", "push", "app"])).toEqual(["cf", "push"]);
});

test("cmake build", () => {
	expect(BashArity.prefix(["cmake", "build"])).toEqual(["cmake", "build"]);
});

test("composer require laravel", () => {
	expect(BashArity.prefix(["composer", "require", "laravel"])).toEqual(["composer", "require"]);
});

test("consul members", () => {
	expect(BashArity.prefix(["consul", "members"])).toEqual(["consul", "members"]);
});

test("crictl ps", () => {
	expect(BashArity.prefix(["crictl", "ps"])).toEqual(["crictl", "ps"]);
});

test("deno run server.ts", () => {
	expect(BashArity.prefix(["deno", "run", "server.ts"])).toEqual(["deno", "run"]);
});

test("docker run nginx", () => {
	expect(BashArity.prefix(["docker", "run", "nginx"])).toEqual(["docker", "run"]);
});

test("docker builder prune", () => {
	expect(BashArity.prefix(["docker", "builder", "prune"])).toEqual(["docker", "builder", "prune"]);
});

test("docker container ls", () => {
	expect(BashArity.prefix(["docker", "container", "ls"])).toEqual(["docker", "container", "ls"]);
});

test("docker image prune", () => {
	expect(BashArity.prefix(["docker", "image", "prune"])).toEqual(["docker", "image", "prune"]);
});

test("docker network inspect", () => {
	expect(BashArity.prefix(["docker", "network", "inspect"])).toEqual(["docker", "network", "inspect"]);
});

test("docker volume ls", () => {
	expect(BashArity.prefix(["docker", "volume", "ls"])).toEqual(["docker", "volume", "ls"]);
});

test("eksctl get clusters", () => {
	expect(BashArity.prefix(["eksctl", "get", "clusters"])).toEqual(["eksctl", "get"]);
});

test("firebase deploy", () => {
	expect(BashArity.prefix(["firebase", "deploy"])).toEqual(["firebase", "deploy"]);
});

test("flyctl deploy", () => {
	expect(BashArity.prefix(["flyctl", "deploy"])).toEqual(["flyctl", "deploy"]);
});

test("git config user.name", () => {
	expect(BashArity.prefix(["git", "config", "user.name"])).toEqual(["git", "config", "user.name"]);
});

test("git remote add origin", () => {
	expect(BashArity.prefix(["git", "remote", "add", "origin"])).toEqual(["git", "remote", "add"]);
});

test("git stash pop", () => {
	expect(BashArity.prefix(["git", "stash", "pop"])).toEqual(["git", "stash", "pop"]);
});

test("go build", () => {
	expect(BashArity.prefix(["go", "build"])).toEqual(["go", "build"]);
});

test("gradle build", () => {
	expect(BashArity.prefix(["gradle", "build"])).toEqual(["gradle", "build"]);
});

test("helm install mychart", () => {
	expect(BashArity.prefix(["helm", "install", "mychart"])).toEqual(["helm", "install"]);
});

test("heroku logs", () => {
	expect(BashArity.prefix(["heroku", "logs"])).toEqual(["heroku", "logs"]);
});

test("hugo new site blog", () => {
	expect(BashArity.prefix(["hugo", "new", "site", "blog"])).toEqual(["hugo", "new"]);
});

test("ip link show", () => {
	expect(BashArity.prefix(["ip", "link", "show"])).toEqual(["ip", "link", "show"]);
});

test("ip link set eth0 up", () => {
	expect(BashArity.prefix(["ip", "link", "set", "eth0", "up"])).toEqual(["ip", "link", "set"]);
});

test("ip netns exec foo bash", () => {
	expect(BashArity.prefix(["ip", "netns", "exec", "foo", "bash"])).toEqual(["ip", "netns", "exec"]);
});

test("ip route add default via 1.1.1.1", () => {
	expect(BashArity.prefix(["ip", "route", "add", "default", "via", "1.1.1.1"])).toEqual(["ip", "route", "add"]);
});

test("kind delete cluster", () => {
	expect(BashArity.prefix(["kind", "delete", "cluster"])).toEqual(["kind", "delete"]);
});

test("kubectl get pods", () => {
	expect(BashArity.prefix(["kubectl", "get", "pods"])).toEqual(["kubectl", "get"]);
});

test("kubectl rollout restart deploy/api", () => {
	expect(BashArity.prefix(["kubectl", "rollout", "restart", "deploy/api"])).toEqual(["kubectl", "rollout", "restart"]);
});

test("kustomize build .", () => {
	expect(BashArity.prefix(["kustomize", "build", "."])).toEqual(["kustomize", "build"]);
});

test("make build", () => {
	expect(BashArity.prefix(["make", "build"])).toEqual(["make", "build"]);
});

test("mc ls myminio", () => {
	expect(BashArity.prefix(["mc", "ls", "myminio"])).toEqual(["mc", "ls"]);
});

test("minikube start", () => {
	expect(BashArity.prefix(["minikube", "start"])).toEqual(["minikube", "start"]);
});

test("mongosh test", () => {
	expect(BashArity.prefix(["mongosh", "test"])).toEqual(["mongosh", "test"]);
});

test("mysql -u root", () => {
	expect(BashArity.prefix(["mysql", "-u", "root"])).toEqual(["mysql", "-u"]);
});

test("mvn compile", () => {
	expect(BashArity.prefix(["mvn", "compile"])).toEqual(["mvn", "compile"]);
});

test("ng generate component home", () => {
	expect(BashArity.prefix(["ng", "generate", "component", "home"])).toEqual(["ng", "generate"]);
});

test("npm install", () => {
	expect(BashArity.prefix(["npm", "install"])).toEqual(["npm", "install"]);
});

test("npm exec vite", () => {
	expect(BashArity.prefix(["npm", "exec", "vite"])).toEqual(["npm", "exec", "vite"]);
});

test("npm init vue", () => {
	expect(BashArity.prefix(["npm", "init", "vue"])).toEqual(["npm", "init", "vue"]);
});

test("npm view react version", () => {
	expect(BashArity.prefix(["npm", "view", "react", "version"])).toEqual(["npm", "view", "react"]);
});

test("nvm use 18", () => {
	expect(BashArity.prefix(["nvm", "use", "18"])).toEqual(["nvm", "use"]);
});

test("nx build", () => {
	expect(BashArity.prefix(["nx", "build"])).toEqual(["nx", "build"]);
});

test("openssl genrsa 2048", () => {
	expect(BashArity.prefix(["openssl", "genrsa", "2048"])).toEqual(["openssl", "genrsa"]);
});

test("openssl x509 -in cert.pem", () => {
	expect(BashArity.prefix(["openssl", "x509", "-in", "cert.pem"])).toEqual(["openssl", "x509", "-in"]);
});

test("pipenv install flask", () => {
	expect(BashArity.prefix(["pipenv", "install", "flask"])).toEqual(["pipenv", "install"]);
});

test("pnpm install", () => {
	expect(BashArity.prefix(["pnpm", "install"])).toEqual(["pnpm", "install"]);
});

test("pnpm exec vite", () => {
	expect(BashArity.prefix(["pnpm", "exec", "vite"])).toEqual(["pnpm", "exec", "vite"]);
});

test("poetry add requests", () => {
	expect(BashArity.prefix(["poetry", "add", "requests"])).toEqual(["poetry", "add"]);
});

test("podman run alpine", () => {
	expect(BashArity.prefix(["podman", "run", "alpine"])).toEqual(["podman", "run"]);
});

test("podman container ls", () => {
	expect(BashArity.prefix(["podman", "container", "ls"])).toEqual(["podman", "container", "ls"]);
});

test("podman image prune", () => {
	expect(BashArity.prefix(["podman", "image", "prune"])).toEqual(["podman", "image", "prune"]);
});

test("psql -d mydb", () => {
	expect(BashArity.prefix(["psql", "-d", "mydb"])).toEqual(["psql", "-d"]);
});

test("pulumi up", () => {
	expect(BashArity.prefix(["pulumi", "up"])).toEqual(["pulumi", "up"]);
});

test("pyenv install 3.11", () => {
	expect(BashArity.prefix(["pyenv", "install", "3.11"])).toEqual(["pyenv", "install"]);
});

test("rake db:migrate", () => {
	expect(BashArity.prefix(["rake", "db:migrate"])).toEqual(["rake", "db:migrate"]);
});

test("rbenv install 3.2.0", () => {
	expect(BashArity.prefix(["rbenv", "install", "3.2.0"])).toEqual(["rbenv", "install"]);
});

test("redis-cli ping", () => {
	expect(BashArity.prefix(["redis-cli", "ping"])).toEqual(["redis-cli", "ping"]);
});

test("rustup update", () => {
	expect(BashArity.prefix(["rustup", "update"])).toEqual(["rustup", "update"]);
});

test("serverless invoke", () => {
	expect(BashArity.prefix(["serverless", "invoke"])).toEqual(["serverless", "invoke"]);
});

test("skaffold dev", () => {
	expect(BashArity.prefix(["skaffold", "dev"])).toEqual(["skaffold", "dev"]);
});

test("sls deploy", () => {
	expect(BashArity.prefix(["sls", "deploy"])).toEqual(["sls", "deploy"]);
});

test("sst deploy", () => {
	expect(BashArity.prefix(["sst", "deploy"])).toEqual(["sst", "deploy"]);
});

test("swift build", () => {
	expect(BashArity.prefix(["swift", "build"])).toEqual(["swift", "build"]);
});

test("systemctl restart nginx", () => {
	expect(BashArity.prefix(["systemctl", "restart", "nginx"])).toEqual(["systemctl", "restart"]);
});

test("terraform apply", () => {
	expect(BashArity.prefix(["terraform", "apply"])).toEqual(["terraform", "apply"]);
});

test("tmux new -s dev", () => {
	expect(BashArity.prefix(["tmux", "new", "-s", "dev"])).toEqual(["tmux", "new"]);
});

test("turbo run build", () => {
	expect(BashArity.prefix(["turbo", "run", "build"])).toEqual(["turbo", "run"]);
});

test("ufw allow 22", () => {
	expect(BashArity.prefix(["ufw", "allow", "22"])).toEqual(["ufw", "allow"]);
});

test("vault login", () => {
	expect(BashArity.prefix(["vault", "login"])).toEqual(["vault", "login"]);
});

test("vault auth list", () => {
	expect(BashArity.prefix(["vault", "auth", "list"])).toEqual(["vault", "auth", "list"]);
});

test("vercel deploy", () => {
	expect(BashArity.prefix(["vercel", "deploy"])).toEqual(["vercel", "deploy"]);
});

test("volta install node", () => {
	expect(BashArity.prefix(["volta", "install", "node"])).toEqual(["volta", "install"]);
});

test("wp plugin install", () => {
	expect(BashArity.prefix(["wp", "plugin", "install"])).toEqual(["wp", "plugin"]);
});

test("yarn add react", () => {
	expect(BashArity.prefix(["yarn", "add", "react"])).toEqual(["yarn", "add"]);
});

test("yarn run dev", () => {
	expect(BashArity.prefix(["yarn", "run", "dev"])).toEqual(["yarn", "run", "dev"]);
});

test("bun install", () => {
	expect(BashArity.prefix(["bun", "install"])).toEqual(["bun", "install"]);
});

test("bun x vite", () => {
	expect(BashArity.prefix(["bun", "x", "vite"])).toEqual(["bun", "x", "vite"]);
});
