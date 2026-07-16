import React from "react";
import { Box, Text } from "ink";
import type { RunEvent } from "../contracts/run";
import { backendMetadata } from "../backends/metadata";
import { normalizeBackend } from "../backends/ids";
import { strictLogIdentity, type LogDisplayMode } from "../runtime/log-presentation";
import { BackendName, Dot, EmptyHint, GateChips, KeyValue, SectionTitle } from "./components";
import { contentFrameRows, contentInsetRows, contentRows, listContentRows, listWindowStart } from "./layout";
import {
  activeFleetProfile,
  activeGoal,
  activityEntries,
  approvalRows,
  configViewModel,
  controlSummary,
  eventSummary,
  fleetAgentRows,
  formatEventLine,
  filterEvents,
  goalSummary,
  goalRows,
  groupRepeatedEvents,
  healthSummary,
  nextActions,
  pendingApprovals,
  truncateDisplay,
  type TuiControlRoomState,
} from "./model";
import { ACCENT, backendTone, BLUE, CHROME, ERR, LIST_OFFSET, MUTED, OK, readinessTone, VIOLET, WARN, goalStateGlyph } from "./theme";

export type ListMeta = { rows: number; start: number; total: number; paneWidth: number };

// ── Overview ────────────────────────────────────────────────────────────────

export function OverviewView({ state, width, height }: { state: TuiControlRoomState; width: number; height: number }) {
  const rows = contentRows(height);
  const frameRows = contentFrameRows(height);
  const inset = contentInsetRows(height);
  const control = controlSummary(state);
  const health = healthSummary(state);
  const goal = goalSummary(state);
  const actions = nextActions(state);
  const actionRows = Math.max(1, actions.length);
  const taskRows = goal ? 4 : 2;
  const fixedRows = 1 + 3 + 2 + taskRows + 1 + actionRows + 1;
  const groupCount = 5;
  const groupGap = rows >= fixedRows + 1 + groupCount - 1 ? 1 : 0;
  const activityRows = Math.max(0, rows - fixedRows - groupGap * (groupCount - 1));
  const activity = activityEntries(state, activityRows);
  const contentWidth = Math.max(8, width - 4);

  return (
    <Box flexDirection="column" paddingX={2} paddingTop={inset} height={frameRows} overflow="hidden">
      <Text bold color={ACCENT} wrap="truncate">OBSERVER OVERVIEW · durable projected state</Text>
      <Box flexDirection="column" marginBottom={groupGap}>
        <SectionTitle title="Topology" tone={ACCENT} width={contentWidth} />
        <Text color={MUTED} wrap="truncate">  {control.connection} · project {control.project} · orchestrator {control.orchestrator} · fleet {control.fleet} · lead {control.lead}</Text>
        <Text color={CHROME} wrap="truncate">  external lead → authenticated daemon → contained workers · this TUI only observes</Text>
      </Box>
      <Box flexDirection="column" marginBottom={groupGap}>
        <SectionTitle title="Health" tone={health.blocked + health.loginRequired || health.trust !== "native ready" ? WARN : OK} width={contentWidth} />
        <Text wrap="truncate">
          <Text>  </Text>
          <Dot tone={health.daemon === "Ready" ? OK : WARN} /><Text color={MUTED}>daemon {health.daemon}</Text>
          <Text color={CHROME}> · </Text>
          <Dot tone={health.trust === "native ready" ? OK : WARN} /><Text color={MUTED}>trust {health.trust}</Text>
          <Text color={CHROME}> · </Text>
          <Text color={OK}>{health.ready} ready</Text>
          <Text color={CHROME}> · </Text>
          <Text color={health.loginRequired ? WARN : MUTED}>{health.loginRequired} login</Text>
          <Text color={CHROME}> · </Text>
          <Text color={health.blocked ? ERR : MUTED}>{health.blocked} blocked</Text>
          <Text color={CHROME}> · </Text>
          <Text color={MUTED}>queue {health.queue} · approvals {health.approvals}</Text>
        </Text>
      </Box>
      <Box flexDirection="column" marginBottom={groupGap}>
        <SectionTitle title="Current task" tone={BLUE} width={contentWidth} />
        {goal ? <>
          <Text color="white" wrap="truncate">  {goal.id} · {goal.status} · {goal.mode} · lead {goal.lead} · stage {goal.stage}</Text>
          <Text color={MUTED} wrap="truncate">  {truncateDisplay(goal.objective, contentWidth - 4)}</Text>
          <Text color={CHROME} wrap="truncate">  use the CLI or attached foreground lead to change this goal</Text>
        </> : <EmptyHint text="No active goal. Start work with the CLI or attached foreground lead." />}
      </Box>
      <Box flexDirection="column" marginBottom={groupGap}>
        <SectionTitle title="Next actions" tone={actions.some((action) => action.risk === "confirm") ? WARN : OK} width={contentWidth} />
        {actions.length === 0 ? <EmptyHint text="Nothing needs you right now." /> : actions.map((action) => <Text key={action.id} color={action.risk === "confirm" ? WARN : MUTED} wrap="truncate">  {action.label} · {action.command} · {action.reason}</Text>)}
      </Box>
      <Box flexDirection="column">
        <SectionTitle title="Recent activity" hint="meaningful · grouped" tone={VIOLET} width={contentWidth} />
        {activityRows > 0 && (activity.length === 0 ? <EmptyHint text="Quiet. Raw provider output remains available in Events." /> : activity.map((entry) => <Text key={entry.id} color={MUTED} wrap="truncate">  <Text color={entry.tone}>{entry.glyph}</Text> {truncateDisplay(entry.text, contentWidth - 6)}</Text>))}
      </Box>
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
      {goal === null ? <EmptyHint text="no active goal · use the CLI or foreground lead to start one" /> : null}
      {goal && glyph ? (
        <>
          <Text wrap="truncate">
            <Text color={glyph.tone}>  {glyph.glyph} {goal.state}</Text>
            <Text color={CHROME}> · </Text>
            <Text color={goal.mode === "write" ? WARN : MUTED}>{goal.mode}</Text>
            <Text color={CHROME}> · synthesizer </Text>
            <Text color="white">{goal.synthesizerAgentId ?? goal.synthesizer.kind}</Text>
          </Text>
          <Text color={MUTED} wrap="truncate">  {truncateDisplay(goal.objective, Math.max(8, width - 4))}</Text>
          <Text color={CHROME} wrap="truncate">  stage: {goalStageLabel(goal.state)} · {goal.mode === "write" ? "write mode (approval may be required)" : "read-only mode"}</Text>
          {height > 4 ? (
            <Text color={CHROME} wrap="truncate">  {state.turns.length} turns · {state.messages.length} messages</Text>
          ) : null}
        </>
      ) : null}
    </Card>
  );
}

function goalStageLabel(state: string): string {
  if (state === "planning" || state === "queued") return "planning";
  if (state === "delegating" || state === "active") return "agents working";
  if (state === "critiquing") return "reviewing results";
  if (state === "gating" || state === "waiting_approval") return "running checks / awaiting approval";
  if (state === "integrating") return "applying approved changes";
  if (state === "succeeded") return "complete";
  if (state === "failed" || state === "timed_out") return "needs attention";
  return state;
}

function nextGoalTransition(state: string) {
  if (state === "queued" || state === "planning") return "admit plan and assign workers";
  if (state === "active" || state === "delegating") return "collect worker evidence";
  if (state === "critiquing") return "finish review and vote";
  if (state === "gating") return "record gate finality";
  if (state === "waiting_approval") return "human approval or rejection";
  if (state === "integrating") return "verify primary integration";
  return "terminal; start or resume other work";
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
      {candidate === null ? <EmptyHint text="none selected · inspect candidates with the CLI" /> : null}
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
  const eventCount = Math.max(0, height - 1 - entries.length);
  const recentEvents = eventCount > 0 ? state.events.slice(-eventCount) : [];
  const compactEvents = groupRepeatedEvents(recentEvents);
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
      {compactEvents.map(({ event, count }) => {
        const line = formatEventLine(event);
        return (
          <Text key={line.id} wrap="truncate">
            <Text color={CHROME}>  {line.time} </Text>
            <Text color={line.tone}>{line.tag}</Text>
            <Text color={MUTED}> {truncateDisplay(line.text, Math.max(8, width - line.tag.length - 14))}{count > 1 ? ` ×${count}` : ""}</Text>
          </Text>
        );
      })}
    </Box>
  );
}

// ── Fleet ───────────────────────────────────────────────────────────────────

export function fleetListMeta(state: TuiControlRoomState, width: number, height: number, selected: number): ListMeta {
  const total = fleetAgentRows(state).length;
  const rows = listContentRows(height);
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
  const frameRows = contentFrameRows(height);
  const inset = contentInsetRows(height);
  const profile = activeFleetProfile(state);
  const agents = fleetAgentRows(state);
  const meta = fleetListMeta(state, width, height, selected);
  const visible = agents.slice(meta.start, meta.start + meta.rows);
  const leftWidth = leftPaneWidth(width);
  const rightWidth = Math.max(24, width - leftWidth - 6);
  const selectedAgent = agents[selected];
  const login = selectedAgent ? loginMetadata(selectedAgent.backend) : null;
  const nameWidth = Math.max(10, Math.floor(leftWidth * 0.4));

  return (
    <Box paddingX={2} paddingTop={inset} height={frameRows} overflow="hidden">
      <Box flexDirection="column" width={leftWidth}>
        <SectionTitle title="Agents" hint={profile ? profile.name : "no profile"} tone={ACCENT} width={leftWidth} />
        <Text color={CHROME} wrap="truncate">  {"agent".padEnd(nameWidth)} {"backend".padEnd(9)} auth</Text>
        {agents.length === 0 ? <EmptyHint text="no agents · configure a fleet profile" /> : null}
        {visible.map((agent, index) => {
          const isSelected = meta.start + index === selected;
          return (
            <Text key={agent.id} wrap="truncate">
              <Text color={isSelected ? ACCENT : CHROME}>{isSelected ? "▸ " : "  "}</Text>
              <Text color={agent.tone}>{agent.glyph} </Text>
              <Text bold={isSelected} color={agent.enabled ? "white" : MUTED}>{truncateDisplay(agent.name, nameWidth).padEnd(nameWidth)}</Text>
              <Text color={backendTone(agent.backend)}> {agent.backend.padEnd(9)}</Text>
              <Text color={agent.authTone}> {agent.auth}</Text>
            </Text>
          );
        })}
      </Box>
      <Box flexDirection="column" width={rightWidth} marginLeft={2} height={rows} overflow="hidden" borderStyle="single" borderColor={CHROME} paddingX={1}>
        <SectionTitle title="Detail" tone={BLUE} width={rightWidth - 4} />
        {profile ? (
          <>
            <KeyValue label="profile">
              <Text color="white">{profile.name}</Text>
              <Text color={CHROME}> ({profile.id})</Text>
            </KeyValue>
            <KeyValue label="policy">
              <Text color={profile.approvalPolicy === "bypass" ? WARN : MUTED}>{profile.approvalPolicy}</Text>
              <Text color={CHROME}> · auth </Text>
              <Text color={profile.authMode === "native-login" ? OK : WARN}>{profile.authMode}</Text>
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
            <Box marginTop={1}><Text color={CHROME}>{"─".repeat(Math.max(4, rightWidth - 4))}</Text></Box>
            <KeyValue label="agent">
              <Text color={selectedAgent.tone}>{selectedAgent.glyph} </Text>
              <Text bold color="white">{selectedAgent.name}</Text>
            </KeyValue>
            <KeyValue label="backend"><BackendName backend={selectedAgent.backend} /><Text color={CHROME}> · load </Text><Text color={MUTED}>{selectedAgent.load}</Text></KeyValue>
            <KeyValue label="readiness"><Dot tone={readinessTone(selectedAgent.readiness)} /><Text color={readinessTone(selectedAgent.readiness)}>{selectedAgent.readiness}</Text></KeyValue>
            {selectedAgent.recovery && selectedAgent.readiness !== "Trust required" && rows >= 12 ? <>
              <KeyValue label="why"><Text color={MUTED}>{truncateDisplay(selectedAgent.recovery.explanation, Math.max(8, rightWidth - 14))}</Text></KeyValue>
              <KeyValue label="next"><Text color={WARN}>{truncateDisplay(selectedAgent.recovery.nextAction, Math.max(8, rightWidth - 14))}</Text></KeyValue>
            </> : null}
            {selectedAgent.recovery && selectedAgent.readiness === "Trust required" && rows >= 12 ? <>
              <KeyValue label="why"><Text color={MUTED}>{truncateDisplay(selectedAgent.recovery.explanation, Math.max(8, rightWidth - 14))}</Text></KeyValue>
              <KeyValue label="grant" labelWidth={6}><Text color={ACCENT} wrap="truncate">{selectedAgent.recovery.nextAction}</Text></KeyValue>
            </> : null}
            {login && selectedAgent.readiness === "Login required" && rows >= 16 ? <>
              <KeyValue label="expects"><Text color={MUTED}>supported provider CLI login state</Text></KeyValue>
              <KeyValue label="login"><Text color={login.interactive && login.argv ? ACCENT : MUTED}>{login.argv ? login.argv.join(" ") : login.instructions}</Text></KeyValue>
              <KeyValue label="actions"><Text color={BLUE}>Use the provider CLI externally · refresh this observer{login.brokerMode ? " · broker mode available" : ""}</Text></KeyValue>
            </> : null}
          </>
        ) : null}
        {state.fleetProfiles.length > 1 ? (
          <>
            <Box marginTop={1}><Text color={CHROME}>{"─".repeat(Math.max(4, rightWidth - 4))}</Text></Box>
            <Text color={CHROME} wrap="truncate">profiles · switch with the root CLI</Text>
            {state.fleetProfiles.slice(0, 3).map((entry) => (
              <Text key={entry.id} color={entry.id === state.activeFleetProfileId ? BLUE : MUTED} wrap="truncate">  {entry.id === state.activeFleetProfileId ? "●" : "○"} {entry.name} ({entry.id})</Text>
            ))}
          </>
        ) : null}
      </Box>
    </Box>
  );
}

function loginMetadata(backend: string) {
  try { return backendMetadata[normalizeBackend(backend)].login ?? null; }
  catch { return null; }
}

// ── Goals ───────────────────────────────────────────────────────────────────

export function goalsListMeta(state: TuiControlRoomState, width: number, height: number, selected: number, historyMode: import("./model").GoalHistoryMode = "recent"): ListMeta {
  const total = goalRows({ ...state, historyMode }).length;
  const rows = listContentRows(height);
  return {
    rows: Math.min(rows, total),
    start: listWindowStart(selected, rows, total),
    total,
    paneWidth: leftPaneWidth(width),
  };
}

export function GoalsView({ state, width, height, selected, historyMode = "recent" }: { state: TuiControlRoomState; width: number; height: number; selected: number; historyMode?: import("./model").GoalHistoryMode }) {
  const rows = contentRows(height);
  const frameRows = contentFrameRows(height);
  const inset = contentInsetRows(height);
  const goals = goalRows({ ...state, historyMode });
  const meta = goalsListMeta(state, width, height, selected, historyMode);
  const visible = goals.slice(meta.start, meta.start + meta.rows);
  const leftWidth = leftPaneWidth(width);
  const rightWidth = Math.max(24, width - leftWidth - 6);
  const selectedRow = goals[selected];
  const detail = selectedRow ? state.goals.find((goal) => goal.id === selectedRow.id) ?? null : null;
  const timelineRows = Math.max(0, rows - 8);
  const timeline = detail && detail.id === state.activeGoalId ? activityEntries(state, timelineRows) : [];

  return (
    <Box paddingX={2} paddingTop={inset} height={frameRows} overflow="hidden">
      <Box flexDirection="column" width={leftWidth}>
        <SectionTitle title="Goals" hint={`${historyMode} · ${goals.length}`} tone={BLUE} width={leftWidth} />
        <Text color={CHROME} wrap="truncate">  state · goal · objective</Text>
        {goals.length === 0 ? <EmptyHint text="no goals yet · start one with the CLI or foreground lead" /> : null}
        {visible.map((goal, index) => {
          const isSelected = meta.start + index === selected;
          return (
            <Text key={goal.id} wrap="truncate">
              <Text color={isSelected ? BLUE : CHROME}>{isSelected ? "▸ " : "  "}</Text>
              <Text color={goal.tone}>{goal.glyph} </Text>
              <Text bold={isSelected} color={goal.active ? ACCENT : "white"}>{goal.id}</Text>
              <Text color={CHROME}> · </Text>
              <Text color={MUTED}>{truncateDisplay(goal.objective, Math.max(8, leftWidth - goal.id.length - 10))}</Text>
            </Text>
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
            <KeyValue label="synth"><Text color="white">{detail.synthesizerAgentId ?? detail.synthesizer.kind}</Text></KeyValue>
            <KeyValue label="owner"><Text color={MUTED}>{detail.principal}</Text></KeyValue>
            <KeyValue label="phase"><Text color={MUTED}>{goalStageLabel(detail.state)}</Text></KeyValue>
            <KeyValue label="next"><Text color={BLUE}>{nextGoalTransition(detail.state)}</Text></KeyValue>
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
  const rows = listContentRows(height, LIST_OFFSET + APPROVAL_DETAIL_ROWS);
  return {
    rows: Math.min(rows, total),
    start: listWindowStart(selected, rows, total),
    total,
    paneWidth: width,
  };
}

export function ApprovalsView({ state, width, height, selected }: { state: TuiControlRoomState; width: number; height: number; selected: number }) {
  const rows = contentRows(height);
  const frameRows = contentFrameRows(height);
  const inset = contentInsetRows(height);
  const approvals = approvalRows(state);
  const meta = approvalsListMeta(state, width, height, selected);
  const visible = approvals.slice(meta.start, meta.start + meta.rows);
  const contentWidth = width - 4;
  const detail = approvals[selected];
  const idWidth = Math.max(10, Math.min(24, Math.floor(contentWidth * 0.2)));

  return (
    <Box flexDirection="column" paddingX={2} paddingTop={inset} height={frameRows} overflow="hidden">
      <SectionTitle
        title="Approvals"
        hint={approvals.length > 0 ? `${approvals.length} pending · resolve with the CLI` : undefined}
        tone={approvals.length > 0 ? WARN : OK}
        width={contentWidth}
      />
      <Text color={CHROME} wrap="truncate">  {"approval".padEnd(idWidth)} {"kind".padEnd(10)} {"from".padEnd(14)} {"age".padEnd(5)} summary</Text>
      {approvals.length === 0 ? <EmptyHint text="nothing pending · agents will queue merge and tool approvals here" /> : null}
      {visible.map((approval, index) => {
        const isSelected = meta.start + index === selected;
        return (
          <Text key={approval.id} wrap="truncate">
            <Text color={isSelected ? BLUE : CHROME}>{isSelected ? "▸ " : "  "}</Text>
            <Text color={WARN}>! </Text>
            <Text bold={isSelected} color="white">{truncateDisplay(approval.id, idWidth).padEnd(idWidth)}</Text>
            <Text color={VIOLET}> {approval.kind.padEnd(10)}</Text>
            <Text color={MUTED}> {truncateDisplay(approval.requestedBy, 14).padEnd(14)}</Text>
            <Text color={CHROME}> {approval.age.padEnd(5)}</Text>
            <Text color={MUTED}> {truncateDisplay(approval.summary, Math.max(8, contentWidth - idWidth - 52))}</Text>
          </Text>
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
          <KeyValue label="resolve"><Text color={MUTED}>headless experimental approval resolve --approval-id {detail.id} …</Text></KeyValue>
        </>
      ) : null}
    </Box>
  );
}

// ── Events ──────────────────────────────────────────────────────────────────

export function eventRowCount(height: number): number {
  return listContentRows(height);
}

export function boundedEventWindow<T>(items: readonly T[], visibleRows: number, scrollBack: number) {
  const count = Math.max(1, Math.floor(visibleRows));
  const offset = Math.max(0, Math.floor(scrollBack));
  const start = Math.max(0, items.length - count - offset);
  return items.slice(start, start + count);
}

export function eventDisplayRows(state: TuiControlRoomState, filter: import("./model").EventFilter, grouped: boolean, mode: LogDisplayMode) {
  const goalSessionIds = state.turns
    .filter((turn) => turn.goalId === state.activeGoalId && turn.nativeSessionId)
    .map((turn) => turn.nativeSessionId!);
  const meaningful = filterEvents(state.events, filter, state.activeGoalId, goalSessionIds, mode)
    .filter((event) => eventSummary(event).trim().length > 0);
  return mode !== "verbose" && grouped
    ? groupRepeatedEvents(meaningful)
    : meaningful.map((event) => ({ event, count: 1 }));
}

export function EventsView({ state, width, height, scrollBack, filter = "all", grouped = true, mode = "compact" }: { state: TuiControlRoomState; width: number; height: number; scrollBack: number; filter?: import("./model").EventFilter; grouped?: boolean; mode?: LogDisplayMode }) {
  const rows = contentRows(height);
  const frameRows = contentFrameRows(height);
  const inset = contentInsetRows(height);
  const visibleRows = eventRowCount(height);
  const contentWidth = width - 4;
  const rowsToShow = eventDisplayRows(state, filter, grouped, mode);
  const visible = boundedEventWindow(rowsToShow, visibleRows, scrollBack);
  const live = scrollBack === 0;
  const committed = live ? visible.slice(0, -1) : [];
  const liveEvent = live ? visible.at(-1) : null;

  return (
    <Box flexDirection="column" paddingX={2} paddingTop={inset} height={frameRows} overflow="hidden">
      <SectionTitle
        title="Events"
        hint={live ? `live · ${mode} · ${filter} · ${rowsToShow.length}/${state.events.length}` : `scrollback ${scrollBack} · ${mode} · ${filter}`}
        tone={live ? OK : WARN}
        width={contentWidth}
      />
      <Text color={CHROME} wrap="truncate">  {mode}: {mode === "compact" ? "grouped outcomes" : mode === "verbose" ? "complete bounded stream" : "structured attributable evidence"} · e errors · a activity · v mode</Text>
      {visible.length === 0 ? <EmptyHint text="no run events yet · dispatch work with the CLI or foreground lead" /> : null}
      {committed.map((item) => (
        <EventLine key={item.event.eventId} event={item.event} count={item.count} contentWidth={contentWidth} mode={mode} />
      ))}
      {liveEvent ? <EventLine event={liveEvent.event} count={liveEvent.count} contentWidth={contentWidth} mode={mode} /> : null}
    </Box>
  );
}

// ── Config ──────────────────────────────────────────────────────────────────

export function ConfigView({ state, width, height }: { state: TuiControlRoomState; width: number; height: number }) {
  const rows = contentRows(height);
  const frameRows = contentFrameRows(height);
  const inset = contentInsetRows(height);
  const contentWidth = width - 4;
  const config = configViewModel(state);
  const split = width >= 92;
  const stateWidth = split ? Math.max(34, Math.floor(contentWidth * 0.42)) : contentWidth;
  const commandsWidth = split ? contentWidth - stateWidth - 2 : contentWidth;
  return (
    <Box paddingX={2} paddingTop={inset} height={frameRows} flexDirection={split ? "row" : "column"} overflow="hidden">
      <Box flexDirection="column" width={stateWidth}>
        <SectionTitle title="Config" hint="observer snapshot" tone={ACCENT} width={stateWidth} />
        <Text color={CHROME} wrap="truncate">  state only · this process cannot mutate project configuration</Text>
        <KeyValue label="project"><Text color={MUTED}>{config.project}</Text></KeyValue>
        <KeyValue label="trust"><Text color={state.projectTrust.trusted ? OK : WARN}>{config.trust}</Text></KeyValue>
        <KeyValue label="lead"><Text color={state.lead?.status === "connected" ? OK : state.lead ? WARN : MUTED}>{config.lead}</Text></KeyValue>
        <KeyValue label="daemon"><Text color={state.connection === "connected" ? OK : WARN}>{config.daemon}</Text></KeyValue>
        <SectionTitle title="Worker delegations" tone={VIOLET} width={stateWidth} />
        {config.delegations.length === 0 ? <EmptyHint text="no worker-delegated children" /> : config.delegations.map((delegation) => (
          <Text key={delegation.id} color={MUTED} wrap="truncate">{delegation.summary}</Text>
        ))}
        <SectionTitle title="Backend readiness" tone={BLUE} width={stateWidth} />
        {config.backends.length === 0 ? <EmptyHint text="no configured backend health is available" /> : config.backends.map((backend) => (
          <Text key={backend.id} wrap="truncate">
            <Text>  </Text>
            <Dot tone={readinessTone(backend.readiness)} />
            <Text color={backendTone(backend.backend)}>{backend.backend.padEnd(12)}</Text>
            <Text color={readinessTone(backend.readiness)}>{backend.readiness}</Text>
            <Text color={CHROME}> · </Text>
            <Text color={MUTED}>{backend.detail}</Text>
          </Text>
        ))}
        <SectionTitle title="Budgets" tone={VIOLET} width={stateWidth} />
        {config.budgets.length === 0 ? <EmptyHint text="no explicit project budgets" /> : config.budgets.map((budget) => (
          <Text key={budget.id} color={MUTED} wrap="truncate">  {budget.id} · {budget.summary}</Text>
        ))}
      </Box>
      <Box flexDirection="column" width={commandsWidth} marginLeft={split ? 2 : 0} marginTop={split ? 0 : 1}>
        <SectionTitle title="Run from your shell" hint="TUI never executes" tone={WARN} width={commandsWidth} />
        {config.commands.map((command) => (
          <Box key={command.id} flexDirection="column" marginBottom={1}>
            <Text color={CHROME}>{command.label}</Text>
            <Text color={ACCENT} wrap="wrap">  {command.command}</Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

function EventLine({ event, count = 1, contentWidth, mode = "compact" }: { event: RunEvent; count?: number; contentWidth: number; mode?: LogDisplayMode }) {
  const line = formatEventLine(event);
  const text = mode === "strict"
    ? `${strictLogIdentity(event)} · ${line.text}${count > 1 ? ` ×${count}` : ""}`
    : `${line.text}${count > 1 ? ` ×${count}` : ""}`;
  return <Text wrap="truncate">
    <Text color={CHROME}>  {line.time} </Text>
    <Text color={line.tone}>{truncateDisplay(line.tag, 12).padEnd(12)}</Text>
    <Text color={event.kind === "stderr" ? WARN : MUTED}> {truncateDisplay(text, Math.max(8, contentWidth - 26))}</Text>
  </Text>;
}

// ── Help ────────────────────────────────────────────────────────────────────

const HELP_COMMANDS: Array<[string, string]> = [
  ["headless lead status", "inspect the configured external foreground lead"],
  ["headless experimental goal list", "inspect or manage goals outside the TUI"],
  ["headless experimental approval list", "review pending human decisions"],
  ["headless experimental candidate inspect", "inspect preserved candidate evidence"],
  ["headless experimental events", "inspect the same durable run-event projection"],
];

const HELP_KEYS: Array<[string, string]> = [
  ["tab / shift+tab", "next / previous view"],
  ["1-7", "jump to a view (empty input)"],
  ["↑ ↓", "select rows · scroll events"],
  ["pgup / pgdn", "page the event feed"],
  ["r", "refresh the observer snapshot"],
  ["esc", "back to overview"],
  ["mouse", "click tabs and rows · wheel scrolls"],
  ["q", "quit (empty input)"],
  ["ctrl+c", "quit"],
];

export function HelpView({ width, height }: { width: number; height: number }) {
  const rows = contentRows(height);
  const frameRows = contentFrameRows(height);
  const inset = contentInsetRows(height);
  const contentWidth = width - 4;
  const split = width >= 96;
  const commandWidth = split ? Math.floor(contentWidth * 0.6) : contentWidth;
  const keysWidth = split ? contentWidth - commandWidth - 2 : contentWidth;
  const commandRows = split ? rows - 1 : Math.max(4, rows - HELP_KEYS.length - 3);
  return (
    <Box paddingX={2} paddingTop={inset} height={frameRows} flexDirection={split ? "row" : "column"} overflow="hidden">
      <Box flexDirection="column" width={commandWidth}>
        <SectionTitle title="Read-only observer" tone={BLUE} width={commandWidth} />
        <Text color={CHROME} wrap="truncate">  The TUI reads observer.snapshot and observer.events only.</Text>
        <Text color={CHROME} wrap="truncate">  It never launches providers, dispatches work, changes policy, or resolves approvals.</Text>
        <Text color={CHROME} wrap="truncate">  Use the root CLI or the explicitly attached foreground lead for state changes.</Text>
        {HELP_COMMANDS.slice(0, Math.max(1, commandRows - 1)).map(([command, description]) => (
          <Text key={command} wrap="truncate">
            <Text color={ACCENT}>  {command.padEnd(30)}</Text>
            <Text color={MUTED}>{truncateDisplay(description, Math.max(8, commandWidth - 34))}</Text>
          </Text>
        ))}
      </Box>
      <Box flexDirection="column" width={keysWidth} marginLeft={split ? 2 : 0} marginTop={split ? 0 : 1}>
        <SectionTitle title="Keys" tone={VIOLET} width={keysWidth} />
        <Text color={CHROME} wrap="truncate">  read-only is safe to inspect; write mode changes files only after approval.</Text>
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
