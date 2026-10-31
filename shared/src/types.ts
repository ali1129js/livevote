/** Wire types shared by the Socket.IO server and the React client. */

export interface PollOption {
  id: string;
  label: string;
  /** True if a voter (not the host) added this option via "Add your own". */
  addedByVoter: boolean;
}

export interface PublicPoll {
  id: string;
  question: string;
  options: PollOption[];
  multiple: boolean;
  allowAddOwn: boolean;
  /** Epoch ms of the scheduled closing time, or null. */
  closesAt: number | null;
  closed: boolean;
  closedBy: "host" | "time" | null;
  expiresAt: number;
}

export interface MyVote {
  optionIds: string[];
  people: number;
}

export interface OptionResult {
  optionId: string;
  label: string;
  /** Number of voters who picked this option. */
  votes: number;
  /** Sum of "people including you" over the voters who picked this option. */
  people: number;
  isLeader: boolean;
}

export interface Results {
  options: OptionResult[];
  /** Number of distinct voters (browsers) that voted. */
  voters: number;
  /** Sum of "people including you" over all voters (each voter counted once). */
  totalPeople: number;
  /** Option ids sharing the highest vote count (empty when nobody voted). */
  leaders: string[];
  tie: boolean;
  /** Copyable summary line for booking. */
  summary: string;
}

/** Everything one connected client is allowed to see. */
export interface ClientState {
  poll: PublicPoll;
  serverNow: number;
  isHost: boolean;
  myVote: MyVote | null;
  /** Whether this voter may still add an option of their own. */
  canAddOption: boolean;
  /** null until the voter has voted (or the poll is closed, or they are the host). */
  results: Results | null;
}

export type ErrorCode =
  | "bad_request"
  | "not_found"
  | "forbidden"
  | "closed"
  | "rate_limited"
  | "limit_reached"
  | "not_joined"
  | "server_error";

export interface ApiError {
  code: ErrorCode;
  message: string;
}

export type Ack<T = undefined> =
  | ({ ok: true } & (T extends undefined ? object : { data: T }))
  | { ok: false; error: ApiError };

export interface CreatePollInput {
  question: string;
  options: string[];
  multiple: boolean;
  allowAddOwn: boolean;
  /** Epoch ms or null. */
  closesAt: number | null;
}

export interface CreatePollResult {
  pollId: string;
  hostToken: string;
}

export interface JoinPayload {
  pollId: string;
  voterId: string;
  hostToken?: string;
}

export interface VotePayload {
  optionIds: string[];
  people: number;
}

export interface AddOptionResult {
  optionId: string;
  /** True if the label matched an existing option and was merged into it. */
  merged: boolean;
}

export interface ClientToServerEvents {
  "poll:join": (p: JoinPayload, ack: (a: Ack<ClientState>) => void) => void;
  "vote:cast": (p: VotePayload, ack: (a: Ack) => void) => void;
  "option:add": (p: { label: string }, ack: (a: Ack<AddOptionResult>) => void) => void;
  "host:close": (ack: (a: Ack) => void) => void;
  "host:reset": (ack: (a: Ack) => void) => void;
  "host:removeOption": (p: { optionId: string }, ack: (a: Ack) => void) => void;
}

export interface ServerToClientEvents {
  "poll:state": (s: ClientState) => void;
  "poll:gone": () => void;
}
