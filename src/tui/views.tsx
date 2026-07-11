import React from "react";
import { Box, Text } from "ink";
import { EmptyHint, GateChips, KeyValue, SectionTitle } from "./components";
import { contentRows, listWindowStart } from "./layout";
import {
  activeFleetProfile,
  activeGoal,
  activityEntries,
  approvalRows,
  fleetAgentRows,
  formatEventLine,
  goalRows,
  pendingApprovals,
  truncateDisplay,
  type TuiControlRoomState,
} from "./model";
import { ACCENT, BLUE, CHROME, ERR, LIST_OFFSET, MUTED, OK, SELECT_BG, SELECT_FG, VIOLET, WARN, goalStateGlyph } from "./theme";

export type ListMeta = { rows: number; start: number; total: number; paneWidth: number };

// ── Overview ────────────────────────────────────────────────────────────────

export function OverviewView({ state, width, height }: { state: TuiControlRoomState; width: number; height: number }) {
  const rows = contentRows(height);
  const narrow = width < 84;
  const cardHeight = narrow
    ? 3
    : Math.max(4, Math.min(6, Math.floor((rows - 5) / 2)));
  const activityHeight = Math.max(3, rows - (narrow ? cardHeight * 4 : cardHeight * 2));
  const cardWidth = narrow ? width - 4 : Math.floor((width - 6) / 2);

  const cards = [
    <FleetCard key="fleet" state={state} width={cardWidth} height={cardHeight} />,
    <GoalCard key="goal" state={state} width={cardWidth} height={cardHeight} />,
    <ApprovalsCard key="approvals" state={state} width={cardWidth} height={cardHeight} />,
    <CandidateCard key="candidate" state={state} width={cardWidth} height={cardHeight} />,
  ];

  return (
    <Box flexDirection="column" paddingX={2} height={rows}>
      {narrow ? (
        <Box flexDirection="column">{cards}</Box>
      ) : (
        <>
          <Box>{cards.slice(0, 2)}</Box>
          <Box>{cards.slice(2)}</Box>
        </>
      )}
      <ActivityFeed state={state} width={width - 4} height={activityHeight} />
    </Box>
  );
}

function Card({ title, hint, tone, width, height, children }: React.PropsWithChildren<{ title: string; hint?: string; tone: string; width: number; height: number }>) {
  return (
    <Box flexDirection="column" width={width} height={height} marginRight={2}>
      <SectionTitle title={title} hint={hint} tone={tone} width={width - 2} />
      {children}
    </Box>
  );
}

function FleetCard({ state, width, height }: { state: TuiControlRoomState; width: number; height: number }) {
  const profile = activeFleetProfile(state);
  const agents = fleetAgentRows(state).slice(0, height - 1);
  return (
    <Card title="Fleet" hint={profile ? `${profile.name} · ${profile.approvalPolicy}` : undefined} tone={ACCENT} width={width} height={height}>
      {profile === null ? <EmptyHint text="no fleet profile · configure one with the CLI" /> : null}
      {agents.map((agent) => (
        <Text key={agent.id} wrap="truncate">
          <Text color={agent.tone}>  {agent.glyph} </Text>
          <Text color={agent.enabled ? "white" : MUTED}>{truncateDisplay(agent.name, Math.max(8, Math.floor(width * 0.34)))}</Text>
          <Text color={CHROME}> · </Text>
          <Text color={MUTED}>{agent.backend}</Text>
          <Text color={CHROME}> · </Text>
          <Text color={agent.authTone}>{agent.auth}</Text>
          <Text color={CHROME}> · load </Text>
          <Text color={MUTED}>{agent.load}</Text>
        </Text>
      ))}
    </Card>
  );
}

function GoalCard({ state, width, height }: { state: TuiControlRoomState; width: number; height: number }) {
  const goal = activeGoal(state);
  const glyph = goal ? goalStateGlyph(goal.state) : null;
  return (
    <Card title="Goal" hint={goal ? goal.id : undefined} tone={BLUE} width={width} height={height}>
      {goal === null ? <EmptyHint text="no active goal · type an objective to start one" /> : null}
      {goal && glyph ? (
        <>
          <Text wrap="truncate">
            <Text color={glyph.tone}>  {glyph.glyph} {goal.state}</Text>
            <Text color={CHROME}> · </Text>
            <Text color={goal.mode === "write" ? WARN : MUTED}>{goal.mode}</Text>
            <Text color={CHROME}> · leader </Text>
            <Text color="white">{goal.leaderAgentId ?? goal.coordinator.kind}</Text>
          </Text>
          <Text color={MUTED} wrap="truncate">  {truncateDisplay(goal.objective, Math.max(8, width - 4))}</Text>
          {height > 4 ? (
            <Text color={CHROME} wrap="truncate">  {state.turns.length} turns · {state.messages.length} messages</Text>
          ) : null}
        </>
      ) : null}
    </Card>
  );
}

function ApprovalsCard({ state, width, height }: { state: TuiControlRoomState; width: number; height: number }) {
  const pending = approvalRows(state).slice(0, height - 1);
  return (
    <Card title="Approvals" hint={pending.length > 0 ? `${pending.length} pending` : undefined} tone={pending.length > 0 ? WARN : OK} width={width} height={height}>
      {pending.length === 0 ? <EmptyHint text="nothing waiting on you" /> : null}
      {pending.map((approval) => (
        <Text key={approval.id} wrap="truncate">
          <Text color={WARN}>  ! </Text>
          <Text color="white">{approval.id}</Text>
          <Text color={CHROME}> · </Text>
          <Text color={VIOLET}>{approval.kind}</Text>
          <Text color={CHROME}> · </Text>
          <Text color={MUTED}>{truncateDisplay(approval.summary, Math.max(8, width - approval.id.length - approval.kind.length - 12))}</Text>
        </Text>
      ))}
    </Card>
  );
}

function CandidateCard({ state, width, height }: { state: TuiControlRoomState; width: number; height: number }) {
  const candidate = state.candidate;
  return (
    <Card title="Candidate" hint={candidate ? candidate.status : undefined} tone={VIOLET} width={width} height={height}>
      {candidate === null ? <EmptyHint text="none inspected · /candidate <id>" /> : null}
      {candidate ? (
        <>
          <Text wrap="truncate">
            <Text color="white">  {candidate.id}</Text>
            <Text color={CHROME}> · </Text>
            <Text color={MUTED}>{truncateDisplay(candidate.summary, Math.max(8, width - candidate.id.length - 8))}</Text>
          </Text>
          {candidate.files.length > 0 && height > 4 ? (
            <Text color={MUTED} wrap="truncate">  {candidate.files.length} file{candidate.files.length === 1 ? "" : "s"} · {truncateDisplay(candidate.files.join(", "), Math.max(8, width - 16))}</Text>
          ) : null}
          <Box paddingLeft={2}><GateChips gates={candidate.gates} /></Box>
        </>
      ) : null}
    </Card>
  );
}

function ActivityFeed({ state, width, height }: { state: TuiControlRoomState; width: number; height: number }) {
  const entries = activityEntries(state, height - 1);
  const recentEvents = state.events.slice(-Math.max(0, height - 1 - entries.length));
  return (
    <Box flexDirection="column" width={width} height={height}>
      <SectionTitle title="Activity" hint={`${state.events.length} events`} tone={OK} width={width} />
      {entries.length === 0 && recentEvents.length === 0 ? <EmptyHint text="quiet · turns, messages, and run events land here" /> : null}
      {entries.map((entry) => (
        <Text key={entry.id} wrap="truncate">
          <Text color={entry.tone}>  {entry.glyph} </Text>
          <Text color={MUTED}>{truncateDisplay(entry.text, Math.max(8, width - 5))}</Text>
        </Text>
      ))}
      {recentEvents.map((event) => {
        const line = formatEventLine(event);
        return (
          <Text key={line.id} wrap="truncate">
            <Text color={CHROME}>  {line.time} </Text>
            <Text color={line.tone}>{line.tag}</Text>
            <Text color={MUTED}> {truncateDisplay(line.text, Math.max(8, width - line.tag.length - 14))}</Text>
          </Text>
        );
      })}
    </Box>
  );
}

// ── Fleet ───────────────────────────────────────────────────────────────────

export function fleetListMeta(state: TuiControlRoomState, width: number, height: number, selected: number): ListMeta {
  const total = fleetAgentRows(state).length;
  const rows = Math.max(1, contentRows(height) - LIST_OFFSET);
  return {
    rows: Math.min(rows, total),
    start: listWindowStart(selected, rows, total),
    total,
    paneWidth: leftPaneWidth(width),
  };
}

function leftPaneWidth(width: number): number {
  return Math.max(34, Math.min(64, Math.floor(width * 0.46)));
}

export function FleetView({ state, width, height, selected }: { state: TuiControlRoomState; width: number; height: number; selected: number }) {
  const rows = contentRows(height);
  const profile = activeFleetProfile(state);
  const agents = fleetAgentRows(state);
  const meta = fleetListMeta(state, width, height, selected);
  const visible = agents.slice(meta.start, meta.start + Math.max(1, rows - LIST_OFFSET));
  const leftWidth = leftPaneWidth(width);
  const rightWidth = Math.max(24, width - leftWidth - 6);
  const selectedAgent = agents[selected];
  const nameWidth = Math.max(10, Math.floor(leftWidth * 0.4));

  return (
    <Box paddingX={2} height={rows}>
      <Box flexDirection="column" width={leftWidth}>
        <SectionTitle title="Agents" hint={profile ? profile.name : "no profile"} tone={ACCENT} width={leftWidth} />
        <Text color={CHROME} wrap="truncate">  {"agent".padEnd(nameWidth)} {"backend".padEnd(9)} auth</Text>
        {agents.length === 0 ? <EmptyHint text="no agents · configure a fleet profile" /> : null}
        {visible.map((agent, index) => {
          const isSelected = meta.start + index === selected;
          return (
            <Box key={agent.id} width={leftWidth} backgroundColor={isSelected ? SELECT_BG : undefined}>
              <Text wrap="truncate">
                <Text color={isSelected ? BLUE : CHROME}>{isSelected ? "▸ " : "  "}</Text>
                <Text color={agent.tone}>{agent.glyph} </Text>
                <Text bold={isSelected} color={agent.enabled ? "white" : MUTED}>{truncateDisplay(agent.name, nameWidth).padEnd(nameWidth)}</Text>
                <Text color={isSelected ? SELECT_FG : MUTED}> {agent.backend.padEnd(9)}</Text>
                <Text color={agent.authTone}> {agent.auth}</Text>
              </Text>
            </Box>
          );
        })}
      </Box>
      <Box flexDirection="column" width={rightWidth} marginLeft={2}>
        <SectionTitle title="Detail" tone={BLUE} width={rightWidth} />
        {profile ? (
          <>
            <KeyValue label="profile">
              <Text color="white">{profile.name}</Text>
              <Text color={CHROME}> ({profile.id})</Text>
            </KeyValue>
            <KeyValue label="policy">
              <Text color={profile.approvalPolicy === "bypass" ? WARN : MUTED}>{profile.approvalPolicy}</Text>
              <Text color={CHROME}> · auth </Text>
              <Text color={MUTED}>{profile.authMode}</Text>
            </KeyValue>
            <KeyValue label="limits">
              <Text color={MUTED}>workers {profile.maxActiveWorkers} · queue {profile.maxQueuedDelegations} · idle {profile.idleAutonomy}</Text>
            </KeyValue>
          </>
        ) : (
          <EmptyHint text="no active fleet profile" />
        )}
        {selectedAgent ? (
          <>
            <Box marginTop={1}><Text color={CHROME}>{"─".repeat(Math.max(4, rightWidth - 2))}</Text></Box>
            <KeyValue label="agent">
              <Text color={selectedAgent.tone}>{selectedAgent.glyph} </Text>
              <Text bold color="white">{selectedAgent.name}</Text>
            </KeyValue>
            <KeyValue label="backend"><Text color={MUTED}>{selectedAgent.backend} · load {selectedAgent.load}</Text></KeyValue>
            <KeyValue label="status"><Text color={MUTED}>{truncateDisplay(selectedAgent.detail, Math.max(8, rightWidth - 12))}</Text></KeyValue>
          </>
        ) : null}
        {state.fleetProfiles.length > 1 ? (
          <>
            <Box marginTop={1}><Text color={CHROME}>{"─".repeat(Math.max(4, rightWidth - 2))}</Text></Box>
            <Text color={CHROME} wrap="truncate">profiles · /use-fleet &lt;id&gt;</Text>
            {state.fleetProfiles.slice(0, 3).map((entry) => (
              <Text key={entry.id} color={entry.id === state.activeFleetProfileId ? BLUE : MUTED} wrap="truncate">  {entry.id === state.activeFleetProfileId ? "●" : "○"} {entry.name} ({entry.id})</Text>
            ))}
          </>
        ) : null}
      </Box>
    </Box>
  );
}

// ── Goals ───────────────────────────────────────────────────────────────────

export function goalsListMeta(state: TuiControlRoomState, width: number, height: number, selected: number): ListMeta {
  const total = goalRows(state).length;
  const rows = Math.max(1, contentRows(height) - LIST_OFFSET);
  return {
    rows: Math.min(rows, total),
    start: listWindowStart(selected, rows, total),
    total,
    paneWidth: leftPaneWidth(width),
  };
}

export function GoalsView({ state, width, height, selected }: { state: TuiControlRoomState; width: number; height: number; selected: number }) {
  const rows = contentRows(height);
  const goals = goalRows(state);
  const meta = goalsListMeta(state, width, height, selected);
  const visible = goals.slice(meta.start, meta.start + Math.max(1, rows - LIST_OFFSET));
  const leftWidth = leftPaneWidth(width);
  const rightWidth = Math.max(24, width - leftWidth - 6);
  const selectedRow = goals[selected];
  const detail = selectedRow ? state.goals.find((goal) => goal.id === selectedRow.id) ?? null : null;
  const timelineRows = Math.max(0, rows - 8);
  const timeline = detail && detail.id === state.activeGoalId ? activityEntries(state, timelineRows) : [];

  return (
    <Box paddingX={2} height={rows}>
      <Box flexDirection="column" width={leftWidth}>
        <SectionTitle title="Goals" hint={`${goals.length} known`} tone={BLUE} width={leftWidth} />
        <Text color={CHROME} wrap="truncate">  state · goal · objective</Text>
        {goals.length === 0 ? <EmptyHint text="no goals yet · type an objective below" /> : null}
        {visible.map((goal, index) => {
          const isSelected = meta.start + index === selected;
          return (
            <Box key={goal.id} width={leftWidth} backgroundColor={isSelected ? SELECT_BG : undefined}>
              <Text wrap="truncate">
                <Text color={isSelected ? BLUE : CHROME}>{isSelected ? "▸ " : "  "}</Text>
                <Text color={goal.tone}>{goal.glyph} </Text>
                <Text bold={isSelected} color={goal.active ? ACCENT : "white"}>{goal.id}</Text>
                <Text color={isSelected ? SELECT_FG : CHROME}> · </Text>
                <Text color={isSelected ? SELECT_FG : MUTED}>{truncateDisplay(goal.objective, Math.max(8, leftWidth - goal.id.length - 10))}</Text>
              </Text>
            </Box>
          );
        })}
      </Box>
      <Box flexDirection="column" width={rightWidth} marginLeft={2}>
        <SectionTitle title={detail ? detail.id : "Detail"} hint={detail?.id === state.activeGoalId ? "active" : undefined} tone={ACCENT} width={rightWidth} />
        {detail === null ? <EmptyHint text="select a goal · enter activates it" /> : null}
        {detail ? (
          <>
            <KeyValue label="state">
              <Text color={goalStateGlyph(detail.state).tone}>{goalStateGlyph(detail.state).glyph} {detail.state}</Text>
              <Text color={CHROME}> · </Text>
              <Text color={detail.mode === "write" ? WARN : MUTED}>{detail.mode}</Text>
            </KeyValue>
            <KeyValue label="leader"><Text color="white">{detail.leaderAgentId ?? detail.coordinator.kind}</Text></KeyValue>
            <KeyValue label="objective"><Text color={MUTED}>{truncateDisplay(detail.objective, Math.max(8, rightWidth - 12))}</Text></KeyValue>
            <Box marginTop={1}><Text color={CHROME}>{"─".repeat(Math.max(4, rightWidth - 2))}</Text></Box>
            {detail.id === state.activeGoalId ? (
              <>
                <Text color={CHROME} wrap="truncate">timeline · {state.turns.length} turns · {state.messages.length} messages</Text>
                {timeline.length === 0 ? <EmptyHint text="no turns or messages yet" /> : null}
                {timeline.map((entry) => (
                  <Text key={entry.id} wrap="truncate">
                    <Text color={entry.tone}>  {entry.glyph} </Text>
                    <Text color={MUTED}>{truncateDisplay(entry.text, Math.max(8, rightWidth - 5))}</Text>
                  </Text>
                ))}
              </>
            ) : (
              <EmptyHint text="enter activates this goal and loads its timeline" />
            )}
          </>
        ) : null}
      </Box>
    </Box>
  );
}

// ── Approvals ───────────────────────────────────────────────────────────────

const APPROVAL_DETAIL_ROWS = 5;

export function approvalsListMeta(state: TuiControlRoomState, width: number, height: number, selected: number): ListMeta {
  const total = pendingApprovals(state).length;
  const rows = Math.max(1, contentRows(height) - LIST_OFFSET - APPROVAL_DETAIL_ROWS);
  return {
    rows: Math.min(rows, total),
    start: listWindowStart(selected, rows, total),
    total,
    paneWidth: width,
  };
}

export function ApprovalsView({ state, width, height, selected }: { state: TuiControlRoomState; width: number; height: number; selected: number }) {
  const rows = contentRows(height);
  const approvals = approvalRows(state);
  const meta = approvalsListMeta(state, width, height, selected);
  const visible = approvals.slice(meta.start, meta.start + Math.max(1, rows - LIST_OFFSET - APPROVAL_DETAIL_ROWS));
  const contentWidth = width - 4;
  const detail = approvals[selected];
  const idWidth = Math.max(10, Math.min(24, Math.floor(contentWidth * 0.2)));

  return (
    <Box flexDirection="column" paddingX={2} height={rows}>
      <SectionTitle
        title="Approvals"
        hint={approvals.length > 0 ? `${approvals.length} pending · enter prefills /approve` : undefined}
        tone={approvals.length > 0 ? WARN : OK}
        width={contentWidth}
      />
      <Text color={CHROME} wrap="truncate">  {"approval".padEnd(idWidth)} {"kind".padEnd(10)} {"from".padEnd(14)} {"age".padEnd(5)} summary</Text>
      {approvals.length === 0 ? <EmptyHint text="nothing pending · agents will queue merge and tool approvals here" /> : null}
      {visible.map((approval, index) => {
        const isSelected = meta.start + index === selected;
        return (
          <Box key={approval.id} width={contentWidth} backgroundColor={isSelected ? SELECT_BG : undefined}>
            <Text wrap="truncate">
              <Text color={isSelected ? BLUE : CHROME}>{isSelected ? "▸ " : "  "}</Text>
              <Text color={WARN}>! </Text>
              <Text bold={isSelected} color="white">{truncateDisplay(approval.id, idWidth).padEnd(idWidth)}</Text>
              <Text color={VIOLET}> {approval.kind.padEnd(10)}</Text>
              <Text color={isSelected ? SELECT_FG : MUTED}> {truncateDisplay(approval.requestedBy, 14).padEnd(14)}</Text>
              <Text color={isSelected ? SELECT_FG : CHROME}> {approval.age.padEnd(5)}</Text>
              <Text color={isSelected ? SELECT_FG : MUTED}> {truncateDisplay(approval.summary, Math.max(8, contentWidth - idWidth - 52))}</Text>
            </Text>
          </Box>
        );
      })}
      {detail ? (
        <>
          <Box marginTop={1}><Text color={CHROME}>{"─".repeat(Math.max(4, contentWidth))}</Text></Box>
          <KeyValue label="selected">
            <Text bold color="white">{detail.id}</Text>
            <Text color={CHROME}> · </Text>
            <Text color={VIOLET}>{detail.kind}</Text>
            <Text color={CHROME}> · from </Text>
            <Text color={MUTED}>{detail.requestedBy}</Text>
            {detail.expiresIn ? <Text color={WARN}> · expires in {detail.expiresIn}</Text> : null}
          </KeyValue>
          <KeyValue label="summary"><Text color={MUTED}>{truncateDisplay(detail.summary, Math.max(8, contentWidth - 12))}</Text></KeyValue>
          <KeyValue label="resolve">
            <Text color={OK}>/approve {detail.id} [reason]</Text>
            <Text color={CHROME}>  ·  </Text>
            <Text color={ERR}>/deny {detail.id} [reason]</Text>
          </KeyValue>
        </>
      ) : null}
    </Box>
  );
}

// ── Events ──────────────────────────────────────────────────────────────────

export function eventRowCount(height: number): number {
  return Math.max(1, contentRows(height) - LIST_OFFSET);
}

export function EventsView({ state, width, height, scrollBack }: { state: TuiControlRoomState; width: number; height: number; scrollBack: number }) {
  const rows = contentRows(height);
  const visibleRows = eventRowCount(height);
  const contentWidth = width - 4;
  const start = Math.max(0, state.events.length - visibleRows - scrollBack);
  const visible = state.events.slice(start, start + visibleRows);
  const live = scrollBack === 0;

  return (
    <Box flexDirection="column" paddingX={2} height={rows}>
      <SectionTitle
        title="Events"
        hint={live ? `live · ${state.events.length} buffered` : `scrollback ${scrollBack} · esc jumps to live`}
        tone={live ? OK : WARN}
        width={contentWidth}
      />
      <Text color={CHROME} wrap="truncate">  time      kind         detail</Text>
      {visible.length === 0 ? <EmptyHint text="no run events yet · dispatch work with /goal or /dispatch" /> : null}
      {visible.map((event) => {
        const line = formatEventLine(event);
        return (
          <Text key={line.id} wrap="truncate">
            <Text color={CHROME}>  {line.time} </Text>
            <Text color={line.tone}>{truncateDisplay(line.tag, 12).padEnd(12)}</Text>
            <Text color={event.kind === "stderr" ? WARN : MUTED}> {truncateDisplay(line.text, Math.max(8, contentWidth - 26))}</Text>
          </Text>
        );
      })}
    </Box>
  );
}

// ── Help ────────────────────────────────────────────────────────────────────

const HELP_COMMANDS: Array<[string, string]> = [
  ["<free text>", "message the active goal coordinator (starts a goal when none is active)"],
  ["/goal <objective>", "start a read-only collaborative goal"],
  ["/goal-write <objective>", "start a write-mode goal"],
  ["/use-goal <id>", "switch the active goal"],
  ["/cancel-goal [id]", "cancel the active (or given) goal"],
  ["/leader <agent-id>", "transfer goal leadership"],
  ["/send <text>", "explicitly send a coordinator turn"],
  ["/ack-message <id…> [--retain]", "acknowledge collaboration messages"],
  ["/approve <id> [reason]", "resolve an approval as approved"],
  ["/deny <id> [reason]", "resolve an approval as rejected"],
  ["/candidate <id>", "inspect an integration candidate"],
  ["/integrate <id>", "integrate an eligible candidate"],
  ["/reject-candidate <id>", "reject a candidate"],
  ["/fleet · /use-fleet <id>", "refresh · activate a fleet profile"],
  ["/policy ask|auto|bypass", "set the fleet approval policy"],
  ["/trust status|grant|revoke", "manage project trust"],
  ["/autonomy on|off", "toggle the orchestrator"],
  ["/dispatch [backend] [prompt]", "queue a contained read-only run"],
  ["/council <question>", "run a fleet council in the background"],
  ["/gate", "run the release gate"],
  ["/claim <task-id> · /pair", "claim durable work"],
  ["/workflow <id>", "show workflow progress"],
  ["/doctor", "one-line connection summary"],
];

const HELP_KEYS: Array<[string, string]> = [
  ["tab / shift+tab", "next / previous view"],
  ["1-6", "jump to a view (empty input)"],
  ["← →", "switch views (empty input)"],
  ["↑ ↓", "select rows · scroll events"],
  ["pgup / pgdn", "page the event feed"],
  ["enter", "send input · pick selected row"],
  ["esc", "clear input · back to live/overview"],
  ["mouse", "click tabs and rows · wheel scrolls"],
  ["q", "quit (empty input)"],
  ["ctrl+c", "quit"],
];

export function HelpView({ width, height }: { width: number; height: number }) {
  const rows = contentRows(height);
  const contentWidth = width - 4;
  const split = width >= 96;
  const commandWidth = split ? Math.floor(contentWidth * 0.6) : contentWidth;
  const keysWidth = split ? contentWidth - commandWidth - 2 : contentWidth;
  const commandRows = split ? rows - 1 : Math.max(4, rows - HELP_KEYS.length - 3);
  return (
    <Box paddingX={2} height={rows} flexDirection={split ? "row" : "column"}>
      <Box flexDirection="column" width={commandWidth}>
        <SectionTitle title="Commands" tone={BLUE} width={commandWidth} />
        {HELP_COMMANDS.slice(0, Math.max(1, commandRows - 1)).map(([command, description]) => (
          <Text key={command} wrap="truncate">
            <Text color={ACCENT}>  {command.padEnd(30)}</Text>
            <Text color={MUTED}>{truncateDisplay(description, Math.max(8, commandWidth - 34))}</Text>
          </Text>
        ))}
      </Box>
      <Box flexDirection="column" width={keysWidth} marginLeft={split ? 2 : 0} marginTop={split ? 0 : 1}>
        <SectionTitle title="Keys" tone={VIOLET} width={keysWidth} />
        {HELP_KEYS.map(([key, description]) => (
          <Text key={key} wrap="truncate">
            <Text color={BLUE}>  {key.padEnd(16)}</Text>
            <Text color={MUTED}>{truncateDisplay(description, Math.max(8, keysWidth - 20))}</Text>
          </Text>
        ))}
      </Box>
    </Box>
  );
}
