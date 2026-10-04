/**
 * Study-evaluation material: a realistic lab handout, a partial and a complete student submission, and a terminal
 * screenshot. Rendered to real PDF/PNG files by a local Chrome, exactly like files a student would upload.
 */
const page = (body: string) => `<section style="page-break-after:always;font:13px/1.5 Georgia,serif;padding:8px 4px">${body}</section>`;
const p = (text: string) => `<p>${text}</p>`;
const h = (text: string) => `<h3 style="margin:14px 0 4px">${text}</h3>`;

export const labHtml = [
  page([
    "<h1 style=\"font-size:20px\">CPRE 2300 — Lab 5: Host Firewall Configuration</h1>",
    p("In this lab you will configure the Uncomplicated Firewall (ufw) on the Ubuntu virtual machine provided for the course."),
    p("Due: Friday, October 17, 11:59 PM, submitted on Canvas."),
    h("Deliverables"),
    p("Submit a single PDF report named lab5_&lt;netid&gt;.pdf containing your answers to every task and the required screenshots."),
    h("Restrictions"),
    p("Work individually. Use only the command line; GUI firewall tools are not allowed. Do not disable the firewall at any point during the lab.")
  ].join("")),
  page([
    h("Task 1: Check the firewall status"),
    p("Run sudo ufw status verbose. Explain what the Default policy line in the output means."),
    h("Task 2: Allow SSH"),
    p("Add a rule that allows SSH on port 22/tcp. Explain why this rule must be added before the firewall is enabled."),
    h("Task 3: Block a web port"),
    p("Block incoming connections to port 8080. Include a screenshot of the output of sudo ufw status numbered that shows the new rule.")
  ].join("")),
  page([
    h("Task 4: Rate limiting"),
    p("Use ufw limit to rate-limit SSH connections. In two or three sentences, explain which attack this mitigates."),
    h("Task 5: Reflection"),
    p("Write a short paragraph (100 to 150 words) describing one rule you would add for a production web server, and why."),
    h("Grading"),
    p("Tasks 1 to 4 are worth 15 points each. Task 5 is worth 20 points. Report formatting is worth 20 points.")
  ].join(""))
].join("");

const task1 = "Task 1</h3><p>I ran sudo ufw status verbose. The output showed Status: active and Default: deny (incoming), allow (outgoing). This means new incoming connections are blocked unless a rule allows them, while outgoing traffic is allowed.</p>";
const task2 = "Task 2</h3><p>I ran sudo ufw allow 22/tcp. This rule must be added before enabling the firewall because otherwise the default deny policy would cut off my SSH session and lock me out of the virtual machine.</p>";
const task3 = "Task 3</h3><p>I ran sudo ufw deny 8080 to block incoming connections on port 8080.</p>";

/** Tasks 1–3 done (Task 3 without its screenshot), Task 4 done wrongly (no ufw limit), Task 5 missing. */
export const partialHtml = page([
  "<h1 style=\"font-size:18px\">Lab 5 Report — Jordan Lee</h1>",
  `<h3>${task1}`, `<h3>${task2}`, `<h3>${task3}`,
  "<h3>Task 4</h3><p>I ran sudo ufw allow 22/tcp again so SSH keeps working.</p>"
].join(""));

/** Everything done; the Task 3 screenshot is a separate image. */
export const completeHtml = page([
  "<h1 style=\"font-size:18px\">Lab 5 Report — Jordan Lee</h1>",
  `<h3>${task1}`, `<h3>${task2}`, `<h3>${task3}<p>The screenshot of sudo ufw status numbered is attached as rules.png.</p>`,
  "<h3>Task 4</h3><p>I ran sudo ufw limit 22/tcp. This rate-limits SSH so an address that opens six or more connections within 30 seconds is denied. It mitigates brute-force password guessing attacks against SSH.</p>",
  "<h3>Task 5</h3><p>For a production web server I would add a rule that allows HTTPS on port 443 only, and deny plain HTTP on port 80 except for a redirect. Encrypting all web traffic protects user credentials and session cookies from being read on the network, and keeping the number of open ports small reduces the attack surface. I would also restrict SSH to the administrators' VPN address range so that the management port is not exposed to the whole internet, which removes most automated attacks. Finally I would enable logging for denied packets so that unusual traffic can be reviewed, because a firewall that nobody monitors gives a false sense of safety and problems would go unnoticed for weeks.</p>"
].join(""));

export const terminalHtml = `<body style="margin:0;background:#0c0c0c;color:#e6e6e6;font:16px Consolas,monospace;padding:14px">
<div>student@lab5:~$ sudo ufw status numbered</div><div>Status: active</div><div>&nbsp;</div>
<div>&nbsp;&nbsp;&nbsp;&nbsp;To&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;Action&nbsp;&nbsp;&nbsp;&nbsp;From</div>
<div>[ 1] 22/tcp&nbsp;&nbsp;&nbsp;&nbsp;LIMIT IN&nbsp;&nbsp;Anywhere</div><div>[ 2] 8080&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;DENY IN&nbsp;&nbsp;&nbsp;Anywhere</div></body>`;
