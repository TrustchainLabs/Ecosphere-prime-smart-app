import { LedgerId, PrivateKey, PublicKey, Status, Transaction } from '@hashgraph/sdk';
import { HederaClientHelper } from '@hsuite/helpers';
import { SmartConfigService } from '@hsuite/smart-config';
import { IHedera, ISmartNode } from '@hsuite/types';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { ChainVCStatus, IDCredential, IDCredentialDocument, IDCredentialStatus } from './entities/credential.entity';
import { Model } from 'mongoose';
import { WalletsService } from 'src/wallets/wallets.service';
import { IVC } from 'src/wallets/interfaces/ivc.namespace';
import { ClientService } from '@hsuite/client';
import { Identity, IdentityDocument } from '../entities/identity.entity';
import { Verifiable, W3CCredential } from "did-jwt-vc"
import { AxiosError } from 'axios';
import { IDIssuer, IDIssuerDocument } from '../../issuers/entities/issuer.entity';
import { UserDocument } from '@hsuite/users';
import { HttpService } from '@nestjs/axios';
import { Hashing } from '@hsuite/did-sdk-js';
import { VCStatusChange } from './credentials.controller';
import { CypherService } from 'src/cypher/cypher.service';



export const VcSlStatus = {
    ACTIVE: 0,
    RESUMED: 1,
    SUSPENDED: 2,
    REVOKED: 3,
};

@Injectable()
export class CredentialsService {
    private logger: Logger = new Logger(CredentialsService.name);
    private environment: string;
    private node: IHedera.IOperator;
    private hederaClient: HederaClientHelper;

    private pinata = {
        baseUrl: 'https://api.pinata.cloud/',
        pinEndPoint: 'pinning/pinJSONToIPFS',
        unpinEndPoint: 'pinning/unpin',
    };

    private pinataAuth = {
        jwt: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySW5mb3JtYXRpb24iOnsiaWQiOiIyMjRmZTA3My1hZWVhLTQzODItODU3Ny04Njg1NjdhN2VkOGUiLCJlbWFpbCI6ImVjb3NwaGVyZTVAc2NpY29tLm15IiwiZW1haWxfdmVyaWZpZWQiOnRydWUsInBpbl9wb2xpY3kiOnsicmVnaW9ucyI6W3siZGVzaXJlZFJlcGxpY2F0aW9uQ291bnQiOjEsImlkIjoiRlJBMSJ9LHsiZGVzaXJlZFJlcGxpY2F0aW9uQ291bnQiOjEsImlkIjoiTllDMSJ9XSwidmVyc2lvbiI6MX0sIm1mYV9lbmFibGVkIjpmYWxzZSwic3RhdHVzIjoiQUNUSVZFIn0sImF1dGhlbnRpY2F0aW9uVHlwZSI6InNjb3BlZEtleSIsInNjb3BlZEtleUtleSI6ImEwYjFhMGU1NTI1MDU5NTc1MzdlIiwic2NvcGVkS2V5U2VjcmV0IjoiZTVmNzI5OGJmYjc4NTkzM2JiMjI2NTQzNzk3MGUwMTk2N2M4ODFlNzcwNGY5NDhmNzcxY2QzOTYwYWQ3Mjg3YyIsImV4cCI6MTc3NzAxOTk5Nn0.DL8kAvohvHCgwV93EZIFngHdsjr58K2JUwf9vbMwQ8w'
    };

    constructor(
        private readonly nodeClientService: ClientService,
        private smartConfigService: SmartConfigService,
        private configService: ConfigService,
        private walletsService: WalletsService,
        private httpService: HttpService,
        private cypherService: CypherService,
        @InjectModel(IDCredential.name) private credentialModel: Model<IDCredentialDocument>,
        @InjectModel(IDIssuer.name) private issuerModel: Model<IDIssuerDocument>,
        @InjectModel(Identity.name) private identityModel: Model<IdentityDocument>
    ) {
        this.environment = this.configService.get<string>('environment');
        this.node = this.configService.get<IHedera.IOperator>(`${this.environment}.node`);

        this.hederaClient = new HederaClientHelper(
            LedgerId.fromString(this.smartConfigService.getEnvironment()),
            this.smartConfigService.getOperator(),
            this.smartConfigService.getMirrorNode()
        );
    }

    private async getIdentityForUser(
        userId: string
    ): Promise<IdentityDocument> {
        return new Promise(async (resolve, reject) => {
            try {
                let identity: IdentityDocument = await this.identityModel.findOne({
                    owner: userId
                });

                if (!identity) {
                    const publicKeyMultibase = Hashing.multibase.encode(
                        PublicKey.fromString(this.node.publicKey).toBytes()
                    );
    
                    let did: IHedera.IDID.IDocument.IInfo = (await this.nodeClientService.axios.post(
                        `/did`, {
                        publicKeyMultibase: publicKeyMultibase
                    })).data;
    
                    identity = await this.identityModel.create({
                        did_id: did.id,
                        owner: userId
                    });
                }

                resolve(identity);
            } catch (error) {
                reject(error);
            }
        });
    }

    async getIssuerForOwner(
        ownerId: string,
        issuerId?: string
    ): Promise<IDIssuer> {
        return new Promise(async (resolve, reject) => {
            try {
                let filters = {
                    owner: ownerId
                }

                if (issuerId) {
                    filters['issuer'] = issuerId;
                }

                let issuer: IDIssuer = await this.issuerModel.findOne(filters);

                if (!issuer) {
                    throw new Error('IDIssuer not found.');
                }

                resolve(issuer);
            } catch (error) {
                reject(error);
            }
        });
    }

    async changeVCStatus(
        sessionId: string,
        userId: string,
        issuerId: string,
        credetialId: string,
        payload: VCStatusChange,
        wipeNFTWithOutChangeVC:boolean
    ): Promise<{ _id:string, internal_status: string,chain_status: string; }> {
        return new Promise(async (resolve, reject) => {
            try {
                let issuer: IDIssuer = await this.getIssuerForOwner(sessionId, issuerId);

                let credential: IDCredentialDocument = await this.credentialModel.findById(credetialId);

                if (!credential) {
                    throw new Error(`User does not have an active credential issued by ${issuer.issuer}`);
                }

                // SMART-NODE CALL: asking the smart-nodes to change the status of VC document...
                if (!wipeNFTWithOutChangeVC){
                let verifiableCredential: Verifiable<W3CCredential> = (await this.nodeClientService.axios.put(
                    `/did/status/${credential.file_id}/${credential.file_index}`, {
                        status: payload.status != ChainVCStatus.EXPIRED ? payload.status : ChainVCStatus.REVOKED
                    })).data;
                }
                let fileIdStatus = await this.nodeClientService.axios.get(`/did/status/${credential.file_id}`)
                let status = await this.decodeVCStatus(fileIdStatus.data.credentialSubject.encodedList, credential.file_index)                    

                // in case the VC has been revoked, we need to unfreeze and burn the NFT...
                if(payload.status == ChainVCStatus.REVOKED) {
                    credential = await this.unfreezeNft(credential, issuer);
                    credential = await this.wipeNft(credential, issuer);
                    credential = await this.freezeNft(credential, issuer);
                }                    
               // credential.chain_status = payload.status;
               if (!wipeNFTWithOutChangeVC){
                credential.chain_status = status.toLowerCase();
               }else{
                credential.chain_status = payload.status;
               }
                credential.markModified('chain_status');

                // if(payload.status == ChainVCStatus.EXPIRED) {
                    credential.internal_status = payload.status;
                    credential.markModified('internal_status');
                // }

                await credential.save();
                const status_return = {
                    _id:credetialId,
                    internal_status: credential.internal_status,
                    chain_status: credential.chain_status,
                                      
                   };
                console.log(credential)
                console.log(status_return)
                resolve(status_return);
            } catch (error) {
                if (error instanceof AxiosError) {
                    reject(new Error(error.response?.data?.message));
                } else {
                    reject(new Error(error.message));
                }
            }
        })
    }

    async decodeVCStatus(encodedList: string, vcStatusListIndex: number): Promise<string> {
        return new Promise(async (resolve, reject) => {
            try {
                const rl = require("vc-revocation-list");
                const decodedStatusList = await rl.decodeList({
                    encodedList: encodedList,
                });
            
                const firstBit = Number(decodedStatusList.isRevoked(vcStatusListIndex)).toString();
                const secondBit = Number(decodedStatusList.isRevoked(vcStatusListIndex + 1)).toString();
             
                const statusIndex = parseInt(`${firstBit}${secondBit}`, 2);
                const status = Object.keys(VcSlStatus).find((key) => VcSlStatus[key] === statusIndex);
             
                resolve(status);
            } catch (error) {
                reject(error);
            }
        });
    }

    async fetchVC(
        issuerSession: UserDocument,
        userId: string,
        issuerId: string
    ): Promise<Array<{
        credential: IDCredentialDocument,
        verifiableCredential: Verifiable<W3CCredential>
    }>> {
        return new Promise(async (resolve, reject) => {
            try {
                
                let issuer: IDIssuer = await this.getIssuerForOwner(<string> issuerSession._id, issuerId);

                let filters = {
                    owner: userId
                }

                if (issuerSession.role != 'admin') {
                    filters['issuer'] = issuer.issuer;
                }

                let credentials: Array<IDCredentialDocument> = await this.credentialModel.find(filters);

                if (!credentials || credentials.length == 0) {
                    throw new Error(`User does not have an active credential issued by ${issuer.issuer}`);
                }

                let verifiableCredentialsRequests = credentials.map(credential =>
                    this.nodeClientService.axios.get(`/did/status/${credential.file_id}`));

                let verifiableCredentialsResponses = await Promise.all(verifiableCredentialsRequests);

                let credentialsStatusRequests = verifiableCredentialsResponses.map((response, index) =>
                    this.decodeVCStatus(response.data.credentialSubject.encodedList, credentials[index].file_index));
                let credentialsStatusResponses = await Promise.all(credentialsStatusRequests);

                let verifiableCredentials = verifiableCredentialsResponses.map((response: any, index) => {
                    credentials[index].chain_status = credentialsStatusResponses[index];

                    return {
                        credential: credentials[index],
                        verifiableCredential: response.data
                    }
                });

                resolve(verifiableCredentials);
            } catch (error) {
                if (error instanceof AxiosError) {
                    reject(new Error(error.response?.data?.message));
                } else {
                    reject(new Error(error.message));
                }
            }
        })
    }

    async issueVC(
        sessionId: string,
        userId: string,
        issuerId: string,
        base64metadata: string,
        expiration_date: string
    ): Promise<IDCredential> {
        return new Promise(async (resolve, reject) => {
            try {
                let issuer: IDIssuer = await this.getIssuerForOwner(sessionId, issuerId);
                let identity: IdentityDocument = await this.getIdentityForUser(userId);

                // checking if the user already has an pending VC for that issuer
                // so to allow the recovery of a failed VC...
                let credential: IDCredentialDocument = await this.credentialModel.findOne({
                    owner: userId,
                    issuer: issuer.issuer,
                    chain_status: 'active',
                    internal_status: {$in: [IDCredentialStatus.PENDING, IDCredentialStatus.MINTED, IDCredentialStatus.DELIVERED, IDCredentialStatus.ACTIVE]}
                });

                //if the user already has an active credential, we throw an error... ()
                if (credential && credential.internal_status == IDCredentialStatus.ACTIVE) {
                    console.warn(`User already has an active credential with issuer ${issuer.issuer}.`)
                    resolve(credential.toJSON());
                   // throw new Error(`User already has an active credential with issuer ${issuer.issuer}.`);
                }

                // if the user does not have an identity, we create a new one...
                if (!credential) {
                    // associate the user WalletID with the IDIssuer's NFT...
                    // try {
                    //     await this.associateNFT(userId, issuer.nftID);
                    // } catch (error) {
                    //     if (!error.message.includes('TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT')) {
                    //         throw new Error('Failed to associate NFT.');
                    //     }
                    // }

                    // if the user does not have an identity, we create a new one...
                    credential = await this.registerVC(userId, issuer, expiration_date);
                    identity.credentials.push(<IDCredential> credential._id);
                    identity.markModified('credentials');
                    await identity.save();

                    // minting the nft...
                    credential = await this.mintNft(credential, issuer, base64metadata,userId);

                    // trying to unfreeze the nft, in case it is already frozen...
                    try {
                        await this.unfreezeNft(credential, issuer);
                    } catch(error) {
                        if (!error.message.includes('TOKEN_NOT_FROZEN')) {
                            this.logger.warn('Failed to unfreeze NFT.');
                        }
                    }

                    // send the nft to the user wallet...
                    credential = await this.sendNft(credential, issuer);

                    // freezing the nft into the user wallet...
                    credential = await this.freezeNft(credential, issuer);
                }
                // if the user has an identity, but it is not active, we try to mint/deliver the nft again...
                else {
                    switch (credential.internal_status) {
                        case IDCredentialStatus.PENDING:
                            console.log('Credential is pending, minting the NFT...');

                            // minting the nft...
                            credential = await this.mintNft(credential, issuer, base64metadata,userId);
                            console.log('Credential after minting the NFT:', credential);
                            // trying to unfreeze the nft, in case it is already frozen...
                            try {
                                await this.unfreezeNft(credential, issuer);
                            } catch(error) {
                                if (!error.message.includes('TOKEN_NOT_FROZEN')) {
                                    this.logger.warn('Failed to unfreeze NFT.');
                                }
                            }

                            // send the nft to the user wallet...
                            credential = await this.sendNft(credential, issuer);
                            // freezing the nft into the user wallet...
                            credential = await this.freezeNft(credential, issuer);
                            credential;
                        case IDCredentialStatus.MINTED:
                            // trying to unfreeze the nft, in case it is already frozen...
                            try {
                                await this.unfreezeNft(credential, issuer);
                            } catch(error) {
                                if (!error.message.includes('TOKEN_NOT_FROZEN')) {
                                    this.logger.warn('Failed to unfreeze NFT.');
                                }
                            }

                            // send the nft to the user wallet...
                            credential = await this.sendNft(credential, issuer);
                            // freezing the nft into the user wallet...
                            credential = await this.freezeNft(credential, issuer);
                            break;
                        case IDCredentialStatus.DELIVERED:
                            // freezing the nft into the user wallet...
                            credential = await this.freezeNft(credential, issuer);
                            break;
                    }
                }

                resolve(credential.toJSON());
            } catch (error) {
                if (error instanceof AxiosError) {
                    reject(new Error(error.response?.data?.message));
                } else {
                    reject(new Error(error.message));
                }
            }
        })
    }

    async registerVC(
        userId: string,
        issuer: IDIssuer,
        expiration_date: string
    ): Promise<IDCredentialDocument> {
        return new Promise(async (resolve, reject) => {
            try {
                // SMART-NODE CALL: asking the smart-nodes to register the VC document...
                let register: IHedera.IDID.IVC.IList.IResponse = (await this.nodeClientService.axios.post(
                    `/did/register`, {
                    issuerDID: `${issuer.did_id}#key-1`,
                })).data;

                let credential: IDCredentialDocument = await this.credentialModel.create({
                    owner: userId,
                    issuer: issuer.issuer,
                    file_id: register.fileId,
                    file_index: register.statusInfo.statusListIndex,
                    serial_number: 'to_be_minted',
                    iv: null,
                    internal_status: IDCredentialStatus.PENDING,
                    chain_status: ChainVCStatus.ACTIVE,
                    expiration_date: new Date(Number(expiration_date))
                });

                resolve(credential);
            } catch (error) {
                if (error instanceof AxiosError) {
                    reject(new Error(error.response?.data?.message));
                } else {
                    reject(new Error(error.message));
                }
            }
        });
    }

    private async associateNFT(
        userId: string,
        nftId: string
    ): Promise<ISmartNode.ISmartTransaction.IDetails> {
        return new Promise(async (resolve, reject) => {
            try {
                let wallet: IVC.Wallet.History = await this.walletsService.getWallet(userId);

                if (!wallet) {
                    throw new Error('User does not have a wallet.');
                }

                let associate: ISmartNode.ISmartTransaction.IDetails = await this.walletsService.associateToken({
                    walletId: wallet.id,
                    tokenId: nftId
                });

                resolve(associate);
            } catch (error) {
                reject(error);
            }
        });
    }

    private async mintNft(
        credential: IDCredentialDocument,
        issuer: IDIssuer,
        base64metadata: string,
        owner:string
    ): Promise<IDCredentialDocument> {
        return new Promise(async (resolve, reject) => {
            try {
                const metadata = Buffer.from(base64metadata, 'base64').toString();
                const vcMetadata = JSON.parse(metadata);
                const encoded = await this.cypherService.encrypt(JSON.stringify(vcMetadata));
                console.log('Encoded:', encoded);
                console.log('Encoded:', encoded.encryptedText);
                console.log('Encoded:', encoded.iv);


                const nftMetadata = {
                    name: `DePIN - Verifiable Credential`,
                    description: `Ecosphere: Hyper-local Climate Intelligence Oracle`,
                    creator: 'ECOSPHERE',
                    properties: {
                        encryptedText: encoded.encryptedText
                    },
                    image: issuer.imageCID
                }
                console.log('NFT Metadata:', nftMetadata);
                // Add custom metadata
                const pinatametadata = JSON.stringify({
                    name: owner,  // This sets the custom file name
                });
                console.log('Pinata Metadata:', pinatametadata);
                let pinataData = JSON.stringify({
                    "pinataOptions": {
                        "cidVersion": 0
                    },
                    "pinataMetadata": pinatametadata,
                    "pinataContent": nftMetadata
                });
                console.log('Pinata Data:', pinataData);
                let response = await this.httpService.post(
                    `${this.pinata.baseUrl}${this.pinata.pinEndPoint}`,
                    pinataData,
                    {
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${this.pinataAuth.jwt}`
                        }
                    }).toPromise();
                console.log('Pinata Response:', response.data);
                if (response.status != 200) {
                    throw new Error('Failed to upload metadata to Pinata.');
                }
                console.log('Pinata Response:', response.data.IpfsHash);
               
                let mintBytes = (await this.nodeClientService.axios.post(
                    `/hts/mint/nft`, {
                    token_id: issuer.nftID,
                    cid: `ipfs://${response.data.IpfsHash}`
                })).data;

                // smart-nodes will return a bytes transaction, ready to be signed and submitted to the network...
                let transaction = Transaction.fromBytes(new Uint8Array(Buffer.from(mintBytes)));
                const client = this.hederaClient.getClient();

                // signing and submitting the transaction...
                // NOTE: the identityTokenID has been created by the same operator of this smart-app, so we can use the same private key.
                const signTx = await transaction.sign(PrivateKey.fromString(this.node.privateKey));

                // submitting the transaction...
                const submitTx = await signTx.execute(client);
                const receipt = await submitTx.getReceipt(client);

                if (receipt.status == Status.Success) {
                    credential.iv = encoded.iv;
                    credential.markModified('iv');

                    credential.serial_number = receipt.serials.toString();
                    credential.markModified('serial_number');

                    credential.internal_status = IDCredentialStatus.MINTED;
                    credential.markModified('status');

                    await credential.save();
                    resolve(credential);
                } else {
                    reject('Transaction failed');
                }
            } catch (error) {
                if (error instanceof AxiosError) {
                    reject(new Error(error.response?.data?.message));
                } else {
                    reject(new Error(error.message));
                }
            }
        })
    }

    private async sendNft(
        credential: IDCredentialDocument,
        issuer: IDIssuer
    ): Promise<IDCredentialDocument> {
        return new Promise(async (resolve, reject) => {
            try {
                let wallet: IVC.Wallet.History = await this.walletsService.getWallet(credential.owner);
                if (!wallet) {
                    throw new Error('User does not have a wallet.');
                }

                if(wallet.balance.tokens.length > 10) {
                    try {
                        await this.associateNFT(credential.owner, issuer.nftID);
                    } catch (error) {
                        if (!error.message.includes('TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT')) {
                            throw new Error('Failed to associate NFT.');
                        }
                    }                    
                }

                // SMART-NODE CALL: asking the smart-nodes to send the nft...
                let sendBytes = (await this.nodeClientService.axios.post(
                    `/hts/transfer/nft`, {
                    nft: issuer.nftID,
                    sender: this.node.accountId,
                    receiver: wallet.id,
                    serial_number: credential.serial_number,
                    memo: `${issuer.issuer} - Identity NFT transfer.`
                })).data;

                // smart-nodes will return a bytes transaction, ready to be signed and submitted to the network...
                let transaction = Transaction.fromBytes(new Uint8Array(Buffer.from(sendBytes)));
                const client = this.hederaClient.getClient();

                // signing and submitting the transaction...
                // NOTE: the identityTokenID has been created by the same operator of this smart-app, so we can use the same private key.
                const signTx = await transaction.sign(PrivateKey.fromString(this.node.privateKey));

                // submitting the transaction...
                const submitTx = await signTx.execute(client);
                const receipt = await submitTx.getReceipt(client);

                if (receipt.status == Status.Success) {
                    credential.internal_status = IDCredentialStatus.DELIVERED;
                    credential.markModified('status');

                    await credential.save();
                    resolve(credential);
                } else {
                    reject('Transaction failed');
                }
            } catch (error) {
                if (error instanceof AxiosError) {
                    reject(new Error(error.response?.data?.message));
                } else {
                    reject(new Error(error.message));
                }
            }
        });
    }

    private async freezeNft(
        credential: IDCredentialDocument,
        issuer: IDIssuer
    ): Promise<IDCredentialDocument> {
        return new Promise(async (resolve, reject) => {
            try {
                let wallet: IVC.Wallet.History = await this.walletsService.getWallet(credential.owner);
                if (!wallet) {
                    throw new Error('User does not have a wallet.');
                }

                // SMART-NODE CALL: asking the smart-nodes to send the nft...
                let sendBytes = (await this.nodeClientService.axios.post(
                    `/hts/freeze/${issuer.nftID}`, {
                    walletId: wallet.id,
                })).data;

                // smart-nodes will return a bytes transaction, ready to be signed and submitted to the network...
                let transaction = Transaction.fromBytes(new Uint8Array(Buffer.from(sendBytes)));
                const client = this.hederaClient.getClient();

                // signing and submitting the transaction...
                // NOTE: the identityTokenID has been created by the same operator of this smart-app, so we can use the same private key.
                const signTx = await transaction.sign(PrivateKey.fromString(this.node.privateKey));

                // submitting the transaction...
                const submitTx = await signTx.execute(client);
                const receipt = await submitTx.getReceipt(client);

                if (receipt.status == Status.Success) {
                    credential.internal_status = IDCredentialStatus.ACTIVE;
                    credential.markModified('status');

                    await credential.save();
                    resolve(credential);
                } else {
                    reject('Transaction failed');
                }
            } catch (error) {
                if (error instanceof AxiosError) {
                    reject(new Error(error.response?.data?.message));
                } else {
                    reject(new Error(error.message));
                }
            }
        });
    }

    private async unfreezeNft(
        credential: IDCredentialDocument,
        issuer: IDIssuer
    ): Promise<IDCredentialDocument> {
        return new Promise(async (resolve, reject) => {
            try {
                let wallet: IVC.Wallet.History = await this.walletsService.getWallet(credential.owner);
                if (!wallet) {
                    throw new Error('User does not have a wallet.');
                }

                // SMART-NODE CALL: asking the smart-nodes to send the nft...
                let sendBytes = (await this.nodeClientService.axios.post(
                    `/hts/unfreeze/${issuer.nftID}`, {
                    walletId: wallet.id,
                })).data;

                // smart-nodes will return a bytes transaction, ready to be signed and submitted to the network...
                let transaction = Transaction.fromBytes(new Uint8Array(Buffer.from(sendBytes)));
                const client = this.hederaClient.getClient();

                // signing and submitting the transaction...
                // NOTE: the identityTokenID has been created by the same operator of this smart-app, so we can use the same private key.
                const signTx = await transaction.sign(PrivateKey.fromString(this.node.privateKey));

                // submitting the transaction...
                const submitTx = await signTx.execute(client);
                const receipt = await submitTx.getReceipt(client);

                if (receipt.status == Status.Success) {
                    resolve(credential);
                } else {
                    reject('Transaction failed');
                }
            } catch (error) {
                if (error instanceof AxiosError) {
                    reject(new Error(error.response?.data?.message));
                } else {
                    reject(new Error(error.message));
                }
            }
        });
    }

    private async wipeNft(
        credential: IDCredentialDocument,
        issuer: IDIssuer
    ): Promise<IDCredentialDocument> {
        return new Promise(async (resolve, reject) => {
            try {
                let wallet: IVC.Wallet.History = await this.walletsService.getWallet(credential.owner);
                if (!wallet) {
                    throw new Error('User does not have a wallet.');
                }

                // SMART-NODE CALL: asking the smart-nodes to send the nft...
                let sendBytes = (await this.nodeClientService.axios.post(
                    `/hts/wipe/nft`, {
                    token_id: issuer.nftID,
                    serial_number: credential.serial_number,
                    account_id: wallet.id
                })).data;

                // smart-nodes will return a bytes transaction, ready to be signed and submitted to the network...
                let transaction = Transaction.fromBytes(new Uint8Array(Buffer.from(sendBytes)));
                const client = this.hederaClient.getClient();

                // signing and submitting the transaction...
                // NOTE: the identityTokenID has been created by the same operator of this smart-app, so we can use the same private key.
                const signTx = await transaction.sign(PrivateKey.fromString(this.node.privateKey));

                // submitting the transaction...
                const submitTx = await signTx.execute(client);
                const receipt = await submitTx.getReceipt(client);

                if (receipt.status == Status.Success) {
                    credential.internal_status = IDCredentialStatus.BURNED;
                    credential.markModified('status');
                    await credential.save();

                    resolve(credential);
                } else {
                    reject('Transaction failed');
                }
            } catch (error) {
                if (error instanceof AxiosError) {
                    reject(new Error(error.response?.data?.message));
                } else {
                    reject(new Error(error.message));
                }
            }
        });
    }
}
