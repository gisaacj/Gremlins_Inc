// 本文件由 tools/gen-shared-data.mjs 自动生成，请勿手工编辑。
// 数据来源: Gremlins, Inc. 原版 Assembly-CSharp.dll (GServer.DM)
// 18 种格子类型 / 3 种费用类型 / 143 种动作原语

/** 格子（站点或建筑）类型 —— 对应原版 ECellType */
export type CellTypeName =
  | 'Astral'
  | 'Bank'
  | 'Bribe'
  | 'Casino'
  | 'Courthouse'
  | 'Danger'
  | 'Income'
  | 'Inferno'
  | 'Jail'
  | 'Junkyard'
  | 'Marketplace'
  | 'Misfortune'
  | 'Office'
  | 'Plant'
  | 'Police'
  | 'Risk'
  | 'Treasure'
  | 'Tribune';

export const CELL_TYPE_NAMES = [
  'Astral',
  'Bank',
  'Bribe',
  'Casino',
  'Courthouse',
  'Danger',
  'Income',
  'Inferno',
  'Jail',
  'Junkyard',
  'Marketplace',
  'Misfortune',
  'Office',
  'Plant',
  'Police',
  'Risk',
  'Treasure',
  'Tribune',
] as const satisfies readonly CellTypeName[];

/** 卡牌/建筑的付费资源类型 —— 对应原版 GPriceType */
export type PriceType =
  | 'Money'
  | 'None'
  | 'Vote';

/** 动作原语 —— 对应原版 EAction，共 143 种，引擎需逐条实现 */
export type ActionType =
  | 'AddTurn'
  | 'AllOpponents'
  | 'AllPlayers'
  | 'Auction'
  | 'BUTTON'
  | 'Banker_Instant_Dividends'
  | 'Banker_Money_Makes_Money_2'
  | 'Banker_Personal_Cashback'
  | 'Banker_Sale_Shares'
  | 'Casino'
  | 'CasinoBonus'
  | 'CasinoReroll'
  | 'ChangeGovernship'
  | 'ChangeTerm'
  | 'Collector_An_Exhibition'
  | 'Collector_Archaeology'
  | 'Collector_Excavation'
  | 'Collector_First_Exhibit'
  | 'Collector_Property_Insurance'
  | 'CompareResource'
  | 'Damned_A_Servant'
  | 'Damned_Aggressor'
  | 'Damned_Ancient_Curse'
  | 'Damned_Connections'
  | 'Damned_The_Dark_Pact'
  | 'Discard'
  | 'Elections'
  | 'Engineer_Golden_Thumb'
  | 'Engineer_Prototype'
  | 'Engineer_Salary'
  | 'Engineer_Trade_Union'
  | 'Enterpreneur_Business_Sense'
  | 'Enterpreneur_Office_Owner'
  | 'Enterpreneur_Promotion'
  | 'Enterpreneur_Risky_Business'
  | 'EvilPlayers'
  | 'Exchange_Perm'
  | 'Freedom'
  | 'Gambler_A_Wager'
  | 'Gambler_Consolidation_Prize'
  | 'Gambler_Lucky_Fellow'
  | 'Gambler_The_Regular'
  | 'GetIncome'
  | 'Homeless_Apathy'
  | 'Homeless_No_Place'
  | 'Homeless_Old_Debts'
  | 'Homeless_Smooth_Sailing'
  | 'Homeless_The_Great'
  | 'IgnoreCell'
  | 'Judge_Court_Connections'
  | 'Judge_Propaganda'
  | 'Judge_Servant_Of_Justice'
  | 'Judge_Stamp_Duty'
  | 'Junkyard'
  | 'MOVE'
  | 'Merchant_Buy_And_Sell'
  | 'Merchant_Move_It'
  | 'Merchant_Skilled_Trader'
  | 'Merchant_Stop'
  | 'MoneyRoll'
  | 'Move_Back'
  | 'NameLocation'
  | 'OpponentArrest'
  | 'OpponentGetMisfortune'
  | 'OpponentGetsYourTerm'
  | 'OpponentLoseIncome'
  | 'OpponentLoseMalice'
  | 'OpponentLoseMoney'
  | 'OpponentLoseScore'
  | 'OpponentLoseVotes'
  | 'OpponentPayMoney'
  | 'OpponentPayScore'
  | 'OpponentRedraw'
  | 'OpponentShowHand'
  | 'OpponentSkipTurn'
  | 'OpponentSwitchPlaces'
  | 'OpponentTeleport'
  | 'PayTerm'
  | 'Perm_AstralElevator'
  | 'Perm_BankIncome'
  | 'Perm_Banker'
  | 'Perm_Bribe'
  | 'Perm_BribeSkip'
  | 'Perm_CasinoMoney'
  | 'Perm_CasinoRoll'
  | 'Perm_CasinoVote'
  | 'Perm_Chaos'
  | 'Perm_Complete_Set'
  | 'Perm_Conflict'
  | 'Perm_Credit'
  | 'Perm_Discard'
  | 'Perm_DiscardFirst'
  | 'Perm_EvilBonus'
  | 'Perm_ExtraCard'
  | 'Perm_Gather'
  | 'Perm_Income'
  | 'Perm_Jail'
  | 'Perm_JailMoney'
  | 'Perm_JunkyardPay'
  | 'Perm_MFSkip'
  | 'Perm_MoveMoney'
  | 'Perm_Plant_Money'
  | 'Perm_RiskBonus'
  | 'Perm_ScoreIncome'
  | 'Perm_SecretVote'
  | 'Perm_Secret_Police'
  | 'Perm_SkipArrest'
  | 'Perm_SpeedPay'
  | 'Perm_Takeover'
  | 'Perm_Trader'
  | 'Perm_TreasureMoney'
  | 'PickCardEarly'
  | 'PlayExtraCard'
  | 'Politician_Astral_Club_2'
  | 'Politician_Charisma'
  | 'Politician_Populist'
  | 'ROLL'
  | 'RandomTeleport'
  | 'RiskVotes'
  | 'SacrificePermanent'
  | 'SameMovePoints'
  | 'SecretAgent_Profitable_Secrets'
  | 'SecretAgent_Secret_Connections'
  | 'SecretAgent_Shaking_The_Tail'
  | 'SelectBonus'
  | 'SelectDeckCard'
  | 'SelectEvil'
  | 'SelectGovernor'
  | 'SelectOpponent'
  | 'SelectPermanent'
  | 'SelectPunishment'
  | 'SelectSelf'
  | 'SelectZek'
  | 'SkipDraw'
  | 'SpecialMove'
  | 'Teleport'
  | 'Thief_Crime_Pays'
  | 'Thief_Jailbird'
  | 'Thief_Pickpocketing'
  | 'Thief_Robbery'
  | 'TopStatBonus'
  | 'TreasureReroll'
  | 'WindOfChanges';

export const ACTION_TYPES = [
  'AddTurn',
  'AllOpponents',
  'AllPlayers',
  'Auction',
  'BUTTON',
  'Banker_Instant_Dividends',
  'Banker_Money_Makes_Money_2',
  'Banker_Personal_Cashback',
  'Banker_Sale_Shares',
  'Casino',
  'CasinoBonus',
  'CasinoReroll',
  'ChangeGovernship',
  'ChangeTerm',
  'Collector_An_Exhibition',
  'Collector_Archaeology',
  'Collector_Excavation',
  'Collector_First_Exhibit',
  'Collector_Property_Insurance',
  'CompareResource',
  'Damned_A_Servant',
  'Damned_Aggressor',
  'Damned_Ancient_Curse',
  'Damned_Connections',
  'Damned_The_Dark_Pact',
  'Discard',
  'Elections',
  'Engineer_Golden_Thumb',
  'Engineer_Prototype',
  'Engineer_Salary',
  'Engineer_Trade_Union',
  'Enterpreneur_Business_Sense',
  'Enterpreneur_Office_Owner',
  'Enterpreneur_Promotion',
  'Enterpreneur_Risky_Business',
  'EvilPlayers',
  'Exchange_Perm',
  'Freedom',
  'Gambler_A_Wager',
  'Gambler_Consolidation_Prize',
  'Gambler_Lucky_Fellow',
  'Gambler_The_Regular',
  'GetIncome',
  'Homeless_Apathy',
  'Homeless_No_Place',
  'Homeless_Old_Debts',
  'Homeless_Smooth_Sailing',
  'Homeless_The_Great',
  'IgnoreCell',
  'Judge_Court_Connections',
  'Judge_Propaganda',
  'Judge_Servant_Of_Justice',
  'Judge_Stamp_Duty',
  'Junkyard',
  'MOVE',
  'Merchant_Buy_And_Sell',
  'Merchant_Move_It',
  'Merchant_Skilled_Trader',
  'Merchant_Stop',
  'MoneyRoll',
  'Move_Back',
  'NameLocation',
  'OpponentArrest',
  'OpponentGetMisfortune',
  'OpponentGetsYourTerm',
  'OpponentLoseIncome',
  'OpponentLoseMalice',
  'OpponentLoseMoney',
  'OpponentLoseScore',
  'OpponentLoseVotes',
  'OpponentPayMoney',
  'OpponentPayScore',
  'OpponentRedraw',
  'OpponentShowHand',
  'OpponentSkipTurn',
  'OpponentSwitchPlaces',
  'OpponentTeleport',
  'PayTerm',
  'Perm_AstralElevator',
  'Perm_BankIncome',
  'Perm_Banker',
  'Perm_Bribe',
  'Perm_BribeSkip',
  'Perm_CasinoMoney',
  'Perm_CasinoRoll',
  'Perm_CasinoVote',
  'Perm_Chaos',
  'Perm_Complete_Set',
  'Perm_Conflict',
  'Perm_Credit',
  'Perm_Discard',
  'Perm_DiscardFirst',
  'Perm_EvilBonus',
  'Perm_ExtraCard',
  'Perm_Gather',
  'Perm_Income',
  'Perm_Jail',
  'Perm_JailMoney',
  'Perm_JunkyardPay',
  'Perm_MFSkip',
  'Perm_MoveMoney',
  'Perm_Plant_Money',
  'Perm_RiskBonus',
  'Perm_ScoreIncome',
  'Perm_SecretVote',
  'Perm_Secret_Police',
  'Perm_SkipArrest',
  'Perm_SpeedPay',
  'Perm_Takeover',
  'Perm_Trader',
  'Perm_TreasureMoney',
  'PickCardEarly',
  'PlayExtraCard',
  'Politician_Astral_Club_2',
  'Politician_Charisma',
  'Politician_Populist',
  'ROLL',
  'RandomTeleport',
  'RiskVotes',
  'SacrificePermanent',
  'SameMovePoints',
  'SecretAgent_Profitable_Secrets',
  'SecretAgent_Secret_Connections',
  'SecretAgent_Shaking_The_Tail',
  'SelectBonus',
  'SelectDeckCard',
  'SelectEvil',
  'SelectGovernor',
  'SelectOpponent',
  'SelectPermanent',
  'SelectPunishment',
  'SelectSelf',
  'SelectZek',
  'SkipDraw',
  'SpecialMove',
  'Teleport',
  'Thief_Crime_Pays',
  'Thief_Jailbird',
  'Thief_Pickpocketing',
  'Thief_Robbery',
  'TopStatBonus',
  'TreasureReroll',
  'WindOfChanges',
] as const satisfies readonly ActionType[];
