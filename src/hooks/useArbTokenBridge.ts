import { useCallback, useEffect, useState } from 'react'
import { BigNumber, constants, ethers, utils } from 'ethers'
import { useLocalStorage } from '@rehooks/local-storage'
import { TokenList } from '@uniswap/token-lists'
import {
  Bridge,
  L1TokenData,
  L2ToL1EventResult,
  OutgoingMessageState,
  WithdrawalInitiated,
  ERC20__factory
} from 'arb-ts'
import useTransactions from './useTransactions'
import {
  AddressToSymbol,
  AddressToDecimals,
  ArbTokenBridge,
  AssetType,
  BridgeBalance,
  BridgeToken,
  ContractStorage,
  ERC20BridgeToken,
  ERC721Balance,
  L2ToL1EventResultPlus,
  PendingWithdrawalsMap,
  TokenType
} from './arbTokenBridge.types'

export const wait = (ms = 0) => {
  return new Promise(res => setTimeout(res, ms))
}

const { Zero } = constants
/* eslint-disable no-shadow */

const slowInboxQueueTimeout = 1000 * 60 * 15

const addressToSymbol: AddressToSymbol = {}
const addressToDecimals: AddressToDecimals = {}

export const useArbTokenBridge = (
  bridge: Bridge,
  autoLoadCache = true
): ArbTokenBridge => {
  const [walletAddress, setWalletAddress] = useState('')

  const defaultBalance = {
    balance: null,
    arbChainBalance: null
  }

  const [ethBalances, setEthBalances] = useState<BridgeBalance>(defaultBalance)

  // inellegant, but works for now: using this state as source of truth (and calling updateBridgeTokens as needed) ensures react recognizes latest state
  const [bridgeTokens, setBridgeTokens] = useState<
    ContractStorage<BridgeToken>
  >({})

  const balanceIsEmpty = (balance: BridgeBalance) =>
    balance['balance'] === defaultBalance['balance'] &&
    balance['arbChainBalance'] === defaultBalance['arbChainBalance']

  const [erc20Balances, setErc20Balances] = useState<
    ContractStorage<BridgeBalance>
  >({})

  const [erc721Balances, setErc721Balances] = useState<
    ContractStorage<ERC721Balance>
  >({})

  const defaultTokenList: string[] = []

  const tokenBlackList: string[] = []
  const [ERC20Cache, setERC20Cache, clearERC20Cache] = useLocalStorage<
    string[]
  >('ERC20Cache', []) as [
    string[],
    React.Dispatch<string[]>,
    React.Dispatch<void>
  ]

  const [ERC721Cache, setERC721Cache, clearERC721Cache] = useLocalStorage<
    string[]
  >('ERC721Cache', []) as [
    string[],
    React.Dispatch<string[]>,
    React.Dispatch<void>
  ]

  interface ExecutedMessagesCache {
    [id: string]: boolean
  }

  const [
    executedMessagesCache,
    setExecutedMessagesCache,
    clearExecutedMessagesCache
  ] = useLocalStorage<ExecutedMessagesCache>('executedMessagesCache', {}) as [
    ExecutedMessagesCache,
    React.Dispatch<ExecutedMessagesCache>,
    React.Dispatch<void>
  ]

  const [pendingWithdrawalsMap, setPendingWithdrawalMap] =
    useState<PendingWithdrawalsMap>({})
  const [
    transactions,
    {
      addTransaction,
      addTransactions,
      setTransactionFailure,
      clearPendingTransactions,
      setTransactionConfirmed,
      updateTransaction,
      removeTransaction,
      addFailedTransaction
    }
  ] = useTransactions()

  const [l11NetworkID, setL1NetWorkID] = useState<string | null>(null)

  const l1NetworkIDCached = useCallback(async () => {
    if (l11NetworkID) return l11NetworkID
    const network = await bridge.l1Bridge.l1Provider.getNetwork()
    const networkID = await network.chainId.toString()
    setL1NetWorkID(networkID)
    return networkID
  }, [l11NetworkID, bridge])

  const walletAddressCached = useCallback(async () => {
    if (walletAddress) {
      return walletAddress
    } else {
      const address = await bridge.l1Bridge.getWalletAddress()
      setWalletAddress(address)
      return address
    }
  }, [walletAddress, bridge])

  const depositEth = async (etherVal: string) => {
    const weiValue: BigNumber = utils.parseEther(etherVal)
    const tx = await bridge.depositETH(weiValue)
    addTransaction({
      type: 'deposit-l1',
      status: 'pending',
      value: etherVal,
      txID: tx.hash,
      assetName: 'ETH',
      assetType: AssetType.ETH,
      sender: await walletAddressCached(),
      l1NetworkID: await l1NetworkIDCached()
    })
    const receipt = await tx.wait()
    const seqNums = await bridge.getInboxSeqNumFromContractTransaction(receipt)
    if (!seqNums) return
    const seqNum = seqNums[0]
    updateTransaction(receipt, tx, seqNum.toNumber())
    updateEthBalances()
  }

  const withdrawEth = useCallback(
    async (etherVal: string) => {
      const weiValue: BigNumber = utils.parseEther(etherVal)
      const tx = await bridge.withdrawETH(weiValue)
      try {
        addTransaction({
          type: 'withdraw',
          status: 'pending',
          value: etherVal,
          txID: tx.hash,
          assetName: 'ETH',
          assetType: AssetType.ETH,
          sender: await walletAddressCached(),
          blockNumber: tx.blockNumber || 0, // TODO: ensure by fetching blocknumber?,
          l1NetworkID: await l1NetworkIDCached()
        })
        const receipt = await tx.wait()

        updateTransaction(receipt, tx)
        updateEthBalances()
        const l2ToL2EventData = await bridge.getWithdrawalsInL2Transaction(
          receipt
        )

        if (l2ToL2EventData.length === 1) {
          const l2ToL2EventDataResult = l2ToL2EventData[0]
          console.info('withdraw event data:', l2ToL2EventDataResult)

          const id = l2ToL2EventDataResult.uniqueId.toString()

          const outgoingMessageState = await getOutGoingMessageState(
            l2ToL2EventDataResult.batchNumber,
            l2ToL2EventDataResult.indexInBatch
          )
          const l2ToL2EventDataResultPlus = {
            ...l2ToL2EventDataResult,
            type: AssetType.ETH,
            value: weiValue,
            outgoingMessageState,
            symbol: 'ETH',
            decimals: 18
          }
          setPendingWithdrawalMap({
            ...pendingWithdrawalsMap,
            [id]: l2ToL2EventDataResultPlus
          })
        }
        return receipt
      } catch (e) {
        console.error('withdrawEth err', e)
      }
    },
    [pendingWithdrawalsMap]
  )

  const approveToken = async (erc20L1Address: string) => {
    const tx = await bridge.approveToken(erc20L1Address)
    const tokenData = (await bridge.getAndUpdateL1TokenData(erc20L1Address))
      .ERC20
    addTransaction({
      type: 'approve',
      status: 'pending',
      value: null,
      txID: tx.hash,
      assetName: (tokenData && tokenData.symbol) || '???',
      assetType: AssetType.ERC20,
      sender: await walletAddressCached(),
      l1NetworkID: await l1NetworkIDCached()
    })

    const receipt = await tx.wait()
    updateTransaction(receipt, tx)
    updateTokenData(erc20L1Address)
  }

  const depositToken = async (erc20Address: string, amount: string) => {
    const _tokenData = await bridge.getAndUpdateL1TokenData(erc20Address)
    if (!(_tokenData && _tokenData.ERC20)) {
      throw new Error('Token data not found')
    }
    const tokenData = _tokenData.ERC20
    const amountParsed = await utils.parseUnits(amount, tokenData.decimals)

    const tx = await bridge.deposit(erc20Address, amountParsed)

    addTransaction({
      type: 'deposit-l1',
      status: 'pending',
      value: amount,
      txID: tx.hash,
      assetName: tokenData.symbol,
      assetType: AssetType.ERC20,
      sender: await walletAddressCached(),
      l1NetworkID: await l1NetworkIDCached()
    })
    try {
      const receipt = await tx.wait()
      const seqNums = await bridge.getInboxSeqNumFromContractTransaction(
        receipt
      )
      if (!seqNums) return
      const seqNum = seqNums[0].toNumber()
      updateTransaction(receipt, tx, seqNum)
      updateTokenData(erc20Address)
      return receipt
    } catch (err) {
      console.warn('deposit token failure', err)
    }
  }

  const withdrawToken = async (erc20l1Address: string, amount: string) => {
    const tokenData = (await bridge.getAndUpdateL1TokenData(erc20l1Address))
      .ERC20
    if (!tokenData) {
      throw new Error("Can't withdraw; token not found")
    }
    const amountParsed = utils.parseUnits(amount, tokenData.decimals)
    const tx = await bridge.withdrawERC20(erc20l1Address, amountParsed)
    addTransaction({
      type: 'withdraw',
      status: 'pending',
      value: amount,
      txID: tx.hash,
      assetName: tokenData.symbol,
      assetType: AssetType.ERC20,
      sender: await bridge.l2Bridge.getWalletAddress(),
      blockNumber: tx.blockNumber || 0,
      l1NetworkID: await l1NetworkIDCached()
    })
    try {
      const receipt = await tx.wait()
      updateTransaction(receipt, tx)

      const l2ToL2EventData = await bridge.getWithdrawalsInL2Transaction(
        receipt
      )
      if (l2ToL2EventData.length === 1) {
        const l2ToL2EventDataResult = l2ToL2EventData[0]
        const id = l2ToL2EventDataResult.uniqueId.toString()
        const outgoingMessageState = await getOutGoingMessageState(
          l2ToL2EventDataResult.batchNumber,
          l2ToL2EventDataResult.indexInBatch
        )
        const l2ToL2EventDataResultPlus = {
          ...l2ToL2EventDataResult,
          type: AssetType.ERC20,
          tokenAddress: erc20l1Address,
          value: amountParsed,
          outgoingMessageState,
          symbol: tokenData.symbol,
          decimals: tokenData.decimals
        }
        setPendingWithdrawalMap({
          ...pendingWithdrawalsMap,
          [id]: l2ToL2EventDataResultPlus
        })
      }
      updateTokenData(erc20l1Address)
      return receipt
    } catch (err) {
      console.warn('withdraw token err', err)
    }
  }
  const addTokensStatic = useCallback(
    (arbTokenList: TokenList) => {
      const bridgeTokensToAdd: ContractStorage<ERC20BridgeToken> = {}
      for (const tokenData of arbTokenList.tokens) {
        console.log(tokenData)

        const {
          address: l2Address,
          name,
          symbol,
          extensions,
          decimals
        } = tokenData
        const l1Address = (extensions as any).l1Address as string
        bridgeTokensToAdd[l1Address] = {
          name,
          type: TokenType.ERC20,
          symbol,
          allowed: false,
          address: l1Address,
          l2Address,
          decimals
        }
      }
      setBridgeTokens({ ...bridgeTokens, ...bridgeTokensToAdd })
    },
    [bridgeTokens]
  )

  const addToken = useCallback(
    async (erc20L1orL2Address: string) => {
      const bridgeTokensToAdd: ContractStorage<ERC20BridgeToken> = {}

      const l1Address = erc20L1orL2Address
      const _l1Data = await bridge.getAndUpdateL1TokenData(erc20L1orL2Address)
      const l1Data = _l1Data.ERC20 || _l1Data.CUSTOM
      if (!l1Data) {
        console.log('l1 token data not found')
        return ''
      }

      const { symbol, allowed, contract } = l1Data
      const name = await contract.name()
      const decimals = await contract.decimals()
      let l2Address: string | undefined
      try {
        const _l2Data = await bridge.getAndUpdateL2TokenData(erc20L1orL2Address)
        const l2Data = _l2Data?.ERC20 || _l2Data?.CUSTOM
        if (!l2Data) {
          throw new Error(``)
        }
        l2Address = l2Data.contract.address
      } catch (error) {
        console.info(`no L2 token for ${l1Address} (which is fine)`)
      }

      bridgeTokensToAdd[l1Address] = {
        name,
        type: TokenType.ERC20,
        symbol,
        allowed,
        address: l1Address,
        l2Address,
        decimals
      }
      const newBridgeTokens = { ...bridgeTokens, ...bridgeTokensToAdd }
      setBridgeTokens(newBridgeTokens)
      return l1Address
    },
    [ERC20Cache, setERC20Cache, bridgeTokens]
  )

  const expireCache = (): void => {
    clearERC20Cache()
    clearERC721Cache()
  }

  useEffect(() => {
    const tokensToAdd = [
      ...new Set([...defaultTokenList].map(t => t.toLocaleLowerCase()))
    ].filter(tokenAddress => !tokenBlackList.includes(tokenAddress))
    if (autoLoadCache) {
      Promise.all(
        tokensToAdd.map(address => {
          return addToken(address).catch(err => {
            console.warn(`invalid cache entry erc20 ${address}`)
            console.warn(err)
          })
        })
      ).then(values => {
        setERC20Cache(values.filter((val): val is string => !!val))
      })
    }
    bridge.l1Bridge.getWalletAddress().then(_address => {
      setWalletAddress(_address)
    })
  }, [])

  const updateEthBalances = async () => {
    const l1Balance = await bridge.getL1EthBalance()
    const l2Balance = await bridge.getL2EthBalance()
    setEthBalances({
      balance: l1Balance,
      arbChainBalance: l2Balance
    })
  }

  const updateTokenData = useCallback(
    async (l1Address: string) => {
      const bridgeToken = bridgeTokens[l1Address]
      if (!bridgeToken) {
        return
      }
      const { l1Data, l2Data } = await bridge.updateTokenData(l1Address)
      const erc20TokenBalance: BridgeBalance = {
        balance: l1Data.ERC20?.balance || l1Data.CUSTOM?.balance || Zero,
        arbChainBalance:
          l2Data?.ERC20?.balance || l2Data?.CUSTOM?.balance || Zero
      }

      setErc20Balances({ ...erc20Balances, [l1Address]: erc20TokenBalance })
      const newBridgeTokens = { ...bridgeTokens, [l1Address]: bridgeToken }
      setBridgeTokens(newBridgeTokens)
    },
    [setErc20Balances, erc20Balances, bridgeTokens, setBridgeTokens]
  )


  const triggerOutboxToken = useCallback(
    async (id: string) => {
      if (!pendingWithdrawalsMap[id])
        throw new Error('Outbox message not found')
      const { batchNumber, indexInBatch, tokenAddress, value } =
        pendingWithdrawalsMap[id]
      const res = await bridge.triggerL2ToL1Transaction(
        batchNumber,
        indexInBatch,
        true
      )

      const tokenData = await bridge.getAndUpdateL1TokenData(
        tokenAddress as string
      )
      const symbol =
        (tokenData && tokenData.ERC20 && tokenData.ERC20.symbol) || '??'
      const decimals =
        (tokenData && tokenData.ERC20 && tokenData.ERC20.decimals) || 18

      addTransaction({
        status: 'pending',
        type: 'outbox',
        value: ethers.utils.formatUnits(value, decimals),
        assetName: symbol,
        assetType: AssetType.ERC20,
        sender: await walletAddressCached(),
        txID: res.hash,
        l1NetworkID: await l1NetworkIDCached()
      })
      try {
        const rec = await res.wait()
        if (rec.status === 1) {
          setTransactionConfirmed(rec.transactionHash)
          const newPendingWithdrawalsMap = { ...pendingWithdrawalsMap }
          delete newPendingWithdrawalsMap[id]
          setPendingWithdrawalMap(newPendingWithdrawalsMap)
          addToExecutedMessagesCache(batchNumber, indexInBatch)
        } else {
          setTransactionFailure(rec.transactionHash)
        }
        return rec
      } catch (err) {
        console.warn('WARNING: token outbox execute failed:', err)
      }
    },
    [pendingWithdrawalsMap]
  )

  const triggerOutboxEth = useCallback(
    async (id: string) => {
      if (!pendingWithdrawalsMap[id])
        throw new Error('Outbox message not found')
      const { batchNumber, indexInBatch, value } = pendingWithdrawalsMap[id]
      const res = await bridge.triggerL2ToL1Transaction(
        batchNumber,
        indexInBatch,
        true
      )

      addTransaction({
        status: 'pending',
        type: 'outbox',
        value: ethers.utils.formatEther(value),
        assetName: 'ETH',
        assetType: AssetType.ETH,
        sender: await walletAddressCached(),
        txID: res.hash,
        l1NetworkID: await l1NetworkIDCached()
      })

      try {
        const rec = await res.wait()
        if (rec.status === 1) {
          setTransactionConfirmed(rec.transactionHash)
          const newPendingWithdrawalsMap = { ...pendingWithdrawalsMap }
          delete newPendingWithdrawalsMap[id]
          setPendingWithdrawalMap(newPendingWithdrawalsMap)
          addToExecutedMessagesCache(batchNumber, indexInBatch)
        } else {
          setTransactionFailure(rec.transactionHash)
        }
        return rec
      } catch (err) {
        console.warn('WARNING: ETH outbox execute failed:', err)
      }
    },
    [pendingWithdrawalsMap]
  )


  const getTokenSymbol = async (_l1Address: string) => {
    const l1Address = _l1Address.toLocaleLowerCase()
    if (addressToSymbol[l1Address]) {
      return addressToSymbol[l1Address]
    }
    try {
      const token = ERC20__factory.connect(l1Address, bridge.l1Provider)
      const symbol = await token.symbol()
      addressToSymbol[l1Address] = symbol
      return symbol
    } catch (err) {
      console.warn('could not get token symbol', err)
      return '???'
    }
  }

  const getTokenDecimals = async (_l1Address: string) => {
    const l1Address = _l1Address.toLocaleLowerCase()
    const dec = addressToDecimals[l1Address]
    if (dec) {
      return dec
    }
    try {
      const token = ERC20__factory.connect(l1Address, bridge.l1Provider)
      const decimals = await token.decimals()
      addressToDecimals[l1Address] = decimals
      return decimals
    } catch (err) {
      console.warn('could not get token decimals', err)
      return 18
    }
  }

  const getEthWithdrawals = async (filter?: ethers.providers.Filter) => {
    const address = await walletAddressCached()
    const t = new Date().getTime()
    const withdrawalData = await bridge.getL2ToL1EventData(address, filter)

    console.log(
      `*** got eth withdraw event in ${
        (new Date().getTime() - t) / 1000
      } seconds ***`
    )

    const outgoingMessageStates = await Promise.all(
      withdrawalData.map((eventData: L2ToL1EventResult) =>
        getOutGoingMessageState(eventData.batchNumber, eventData.indexInBatch)
      )
    )

    return withdrawalData
      .map((eventData, i) => {
        const {
          caller,
          destination,
          uniqueId,
          batchNumber,
          indexInBatch,
          arbBlockNum,
          ethBlockNum,
          timestamp,
          callvalue,
          data
        } = eventData

        if (!data || data === '0x') {
          // is an eth withdrawal
          const allWithdrawalData: L2ToL1EventResultPlus = {
            caller,
            destination,
            uniqueId,
            batchNumber,
            indexInBatch,
            arbBlockNum,
            ethBlockNum,
            timestamp,
            callvalue,
            data,
            type: AssetType.ETH,
            value: callvalue,
            symbol: 'ETH',
            outgoingMessageState: outgoingMessageStates[i],
            decimals: 18
          }
          return allWithdrawalData
        }
      })
      .filter((x): x is L2ToL1EventResultPlus => !!x)
  }

  const getTokenWithdrawals = async (
    gatewayAddresses: string[],
    filter?: ethers.providers.Filter
  ) => {
    const address = await walletAddressCached()
    const t = new Date().getTime()

    const gateWayWithdrawalsResultsNested = await Promise.all(
      gatewayAddresses.map(gatewayAddress =>
        bridge.getGatewayWithdrawEventData(gatewayAddress, address, filter)
      )
    )
    console.log(
      `*** got token gateway event data in ${
        (new Date().getTime() - t) / 1000
      } seconds *** `
    )

    const gateWayWithdrawalsResults = gateWayWithdrawalsResultsNested.flat()
    const symbols = await Promise.all(
      gateWayWithdrawalsResults.map(withdrawEventData =>
        getTokenSymbol(withdrawEventData.l1Token)
      )
    )
    const decimals = await Promise.all(
      gateWayWithdrawalsResults.map(withdrawEventData =>
        getTokenDecimals(withdrawEventData.l1Token)
      )
    )

    const l2Txns = await Promise.all(
      gateWayWithdrawalsResults.map(withdrawEventData =>
        bridge.getL2Transaction(withdrawEventData.txHash)
      )
    )
    // pause to space out queries for rate limit:
    await wait(500 * l2Txns.length)

    const outgoingMessageStates = await Promise.all(
      gateWayWithdrawalsResults.map((withdrawEventData, i) => {
        const eventDataArr = bridge.getWithdrawalsInL2Transaction(l2Txns[i])
        // TODO: length != 1
        const { batchNumber, indexInBatch } = eventDataArr[0]
        return getOutGoingMessageState(batchNumber, indexInBatch)
      })
    )
    return gateWayWithdrawalsResults.map(
      (withdrawEventData: WithdrawalInitiated, i) => {
        // TODO: length != 1
        const eventDataArr = bridge.getWithdrawalsInL2Transaction(l2Txns[i])
        const {
          caller,
          destination,
          uniqueId,
          batchNumber,
          indexInBatch,
          arbBlockNum,
          ethBlockNum,
          timestamp,
          callvalue,
          data
        } = eventDataArr[0]

        const eventDataPlus: L2ToL1EventResultPlus = {
          caller,
          destination,
          uniqueId,
          batchNumber,
          indexInBatch,
          arbBlockNum,
          ethBlockNum,
          timestamp,
          callvalue,
          data,
          type: AssetType.ERC20,
          value: withdrawEventData._amount,
          tokenAddress: withdrawEventData.l1Token,
          outgoingMessageState: outgoingMessageStates[i],
          symbol: symbols[i],
          decimals: decimals[i]
        }
        return eventDataPlus
      }
    )
  }

  const setInitialPendingWithdrawals = async (
    gatewayAddresses: string[],
    filter?: ethers.providers.Filter
  ) => {
    const pendingWithdrawals: PendingWithdrawalsMap = {}
    const t = new Date().getTime()
    console.log('*** Getting initial pending withdrawal data ***')

    const l2ToL1Txns = (
      await Promise.all([
        getEthWithdrawals(filter),
        getTokenWithdrawals(gatewayAddresses, filter)
      ])
    ).flat()

    console.log(
      `*** done getting pending withdrawals, took ${
        Math.round(new Date().getTime() - t) / 1000
      } seconds`
    )

    for (const l2ToL1Thing of l2ToL1Txns) {
      pendingWithdrawals[l2ToL1Thing.uniqueId.toString()] = l2ToL1Thing
    }
    setPendingWithdrawalMap(pendingWithdrawals)
    return
  }

  const getOutGoingMessageState = useCallback(
    async (batchNumber: BigNumber, indexInBatch: BigNumber) => {
      if (
        executedMessagesCache[hashOutgoingMessage(batchNumber, indexInBatch)]
      ) {
        return OutgoingMessageState.EXECUTED
      } else {
        return bridge.getOutGoingMessageState(batchNumber, indexInBatch)
      }
    },
    [executedMessagesCache]
  )

  const addToExecutedMessagesCache = useCallback(
    (batchNumber: BigNumber, indexInBatch: BigNumber) => {
      const _executedMessagesCache = { ...executedMessagesCache }
      _executedMessagesCache[hashOutgoingMessage(batchNumber, indexInBatch)] =
        true
      setExecutedMessagesCache(_executedMessagesCache)
    },
    [executedMessagesCache]
  )

  const hashOutgoingMessage = (
    batchNumber: BigNumber,
    indexInBatch: BigNumber
  ) => {
    return batchNumber.toString() + ',' + indexInBatch.toString()
  }

  return {
    walletAddress,
    bridgeTokens: bridgeTokens,
    balances: {
      eth: ethBalances,
      erc20: erc20Balances,
      erc721: erc721Balances
    },
    cache: {
      erc20: ERC20Cache,
      erc721: ERC721Cache,
      expire: expireCache
    },
    eth: {
      deposit: depositEth,
      withdraw: withdrawEth,
      triggerOutbox: triggerOutboxEth,
      updateBalances: updateEthBalances
    },
    token: {
      add: addToken,
      addTokensStatic,
      updateTokenData,
      approve: approveToken,
      deposit: depositToken,
      withdraw: withdrawToken,
      triggerOutbox: triggerOutboxToken
    },
    arbSigner: bridge.l2Bridge.l2Signer,
    transactions: {
      transactions,
      clearPendingTransactions,
      setTransactionConfirmed,
      updateTransaction,
      addTransaction,
      addTransactions
    },
    pendingWithdrawalsMap: pendingWithdrawalsMap,
    setInitialPendingWithdrawals: setInitialPendingWithdrawals
  }
}
