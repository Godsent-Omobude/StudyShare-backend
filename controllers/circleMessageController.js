import { createCircleMessage, editCircleMessage, deleteCircleMessage, pinCircleMessage, unpinCircleMessage } from "../services/circleMessages.js";
import prisma from "../config/prisma.js";
import { getMembership, canRemoveMember } from "../services/circleAccess.js";
import { createNotification, removeUserFromCircleSockets, emitToCircle } from "../services/circleRealtime.js";

const parseId = (value) => { const id = Number.parseInt(value, 10); return Number.isNaN(id) ? null : id; };
const send = (res, error, fallback) => res.status(error.status || 500).json({ message: error.message || fallback });

export const createMessage = async (req, res) => { try { const circleId=parseId(req.params.id); if(!circleId)return res.status(400).json({message:"Invalid circle ID."}); return res.status(201).json(await createCircleMessage(circleId, req.user.id, req.body.content)); } catch(e){return send(res,e,"Unable to send message.");} };
export const editMessage = async (req, res) => { try { const circleId=parseId(req.params.id); if(!circleId)return res.status(400).json({message:"Invalid circle ID."}); return res.json(await editCircleMessage(circleId, req.params.messageId, req.user.id, req.body.content)); } catch(e){return send(res,e,"Unable to edit message.");} };
export const deleteMessage = async (req, res) => { try { const circleId=parseId(req.params.id); if(!circleId)return res.status(400).json({message:"Invalid circle ID."}); return res.json(await deleteCircleMessage(circleId, req.params.messageId, req.user.id)); } catch(e){return send(res,e,"Unable to delete message.");} };
export const pinMessage = async (req,res)=>{try{const circleId=parseId(req.params.id);if(!circleId)return res.status(400).json({message:"Invalid circle ID."});return res.json(await pinCircleMessage(circleId,req.params.messageId,req.user.id));}catch(e){return send(res,e,"Unable to pin message.");}};
export const unpinMessage = async (req,res)=>{try{const circleId=parseId(req.params.id);if(!circleId)return res.status(400).json({message:"Invalid circle ID."});return res.json(await unpinCircleMessage(circleId,req.params.messageId,req.user.id));}catch(e){return send(res,e,"Unable to unpin message.");}};

export const listPinnedMessages = async (req,res)=>{
  try { const circleId=parseId(req.params.id); if(!circleId)return res.status(400).json({message:"Invalid circle ID."}); const membership=await getMembership(circleId,req.user.id); if(!membership)return res.status(403).json({message:"You must be a member of this circle."});
    const pins=await prisma.circlePinnedMessage.findMany({where:{circleId,message:{deletedAt:null}},include:{message:{include:{user:{select:{id:true,username:true}}}},pinnedByUser:{select:{username:true}}},orderBy:{createdAt:"desc"}});
    return res.json(pins.map(p=>({id:p.id,messageId:p.messageId,createdAt:p.createdAt,pinnedByUsername:p.pinnedByUser.username,message:{id:p.message.id,content:p.message.content,createdAt:p.message.createdAt,userId:p.message.userId,username:p.message.user.username}})));
  } catch(e){return send(res,e,"Unable to load pinned messages.");}
};

export const removeMember = async (req,res)=>{
  try {
    const circleId=parseId(req.params.id), targetUserId=parseId(req.params.userId);
    if(!circleId||!targetUserId)return res.status(400).json({message:"Invalid ID."});
    const actor=await getMembership(circleId,req.user.id), target=await getMembership(circleId,targetUserId);
    if(!canRemoveMember(actor,target,req.user.id))return res.status(403).json({message:"You do not have permission to remove this member."});
    await prisma.circleMember.delete({where:{id:target.id}});
    removeUserFromCircleSockets(targetUserId,circleId);
    emitToCircle(circleId,"member:removed",{circleId,userId:targetUserId});
    await createNotification({userId:targetUserId,type:"CIRCLE_MEMBER_REMOVED",title:"Removed from Study Circle",body:"You were removed from a Study Circle.",circleId,actorUserId:req.user.id});
    return res.json({message:"Member removed."});
  } catch(e){return send(res,e,"Unable to remove member.");}
};
